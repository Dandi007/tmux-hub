import type { ServerWebSocket } from "bun";
import type { SessionBroadcaster } from "./output-broadcaster";
import { HubError, type InputRouter } from "./input-router";
import type { SseHub } from "./sse";
import type { ManagedSessionDb } from "./managed-db";
import type { TmuxResult } from "./tmux-cmd";
import type { createLogger } from "./logger";
import { ResyncScheduler } from "./resize-resync";
import { adoptUnsubs } from "./ws-attach";
import { SessionPeers } from "./session-peers";

export type WsData = {
  sessionName: string;
  cols: number;
  rows: number;
  connId: string;
  unsubs: Array<() => void>;
  // The session's broadcaster, set after attach so resize messages can keep the
  // emulator grid aligned with the pane.
  broadcaster?: SessionBroadcaster;
  // Client opted in (`?resync=1`) to an aligned snapshot after each applied
  // resize, announced by a `{kind:"resync"}` message. Opt-in so a stale page
  // that does not know the message never gets it written into its terminal.
  resyncCapable: boolean;
  // false: a hidden desktop-pool slot — attach at the pane's current size
  // without pinning it (the client pins on activation with a resize message).
  pin: boolean;
  resync?: ResyncScheduler;
  closed?: boolean;
};

export function clampInt(v: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}

export type WsDeps = {
  broadcasters: { get(session: string): Promise<SessionBroadcaster> };
  getNativeAttachCount: (session: string) => Promise<number>;
  pinViewport: (session: string, cols: number, rows: number) => Promise<unknown>;
  tmux: (args: string[]) => Promise<TmuxResult>;
  sse: Pick<SseHub, "emit">;
  managedDb: Pick<ManagedSessionDb, "getScrollPos" | "setScrollPos">;
  input: Pick<InputRouter, "send">;
  logger: ReturnType<typeof createLogger>;
};

// The terminal websocket handlers, with their collaborators injected so tests
// can drive real WebSocket connections against fakes.
export function createWsHandlers(deps: WsDeps) {
  const { broadcasters, getNativeAttachCount, pinViewport, tmux, sse, managedDb, input, logger } = deps;
  let connections = 0;
  // Web pages per session. A pin by one page re-sizes the pane under the others:
  // they adopt the new size and get an aligned resync; when the pinning page
  // leaves, they are told to reclaim.
  const peers = new SessionPeers<ServerWebSocket<WsData>>();
  function released(ws: ServerWebSocket<WsData>): void {
    for (const p of peers.others(ws.data.sessionName, ws)) {
      try { p.send(JSON.stringify({ kind: "viewport", cols: ws.data.cols, rows: ws.data.rows, owner: "web", released: true })); } catch {}
    }
  }
  function pinnedBy(ws: ServerWebSocket<WsData>, cols: number, rows: number): void {
    const { sessionName } = ws.data;
    // Closed while the pin was in flight: close() already ran, so the pane now
    // has a dead client's size and nobody would ever release it. Let the other
    // pages reclaim it instead of recording the dead ws as pinner.
    if (ws.data.closed) { released(ws); return; }
    peers.pinned(sessionName, ws);
    for (const p of peers.others(sessionName, ws)) {
      try { p.send(JSON.stringify({ kind: "viewport", cols, rows, owner: "web", peer: true })); } catch {}
      p.data.resync?.resized(cols, rows);
    }
  }

  return {
    connections: () => connections,
    peers,
    async open(ws: ServerWebSocket<WsData>) {
      connections++;
      const { sessionName, cols, rows, connId } = ws.data;
      logger.info({ session: sessionName, cols, rows, connId }, "ws open");

      // Authoritative pane size for the emulator snapshot. Defaults to this
      // client's requested size (web owns → we pin the pane to it below); when a
      // native client owns the pane, it is overwritten with the queried size.
      let paneCols = cols;
      let paneRows = rows;

      // Ownership guard: skip pin if native client attached
      let attachCount = 0;
      try {
        attachCount = await getNativeAttachCount(sessionName);
      } catch (e) {
        logger.warn({ session: sessionName, connId, err: e }, "getNativeAttachCount failed, assuming native attached");
        attachCount = 1; // fail-safe: treat as native attached
      }
      if (ws.data.closed) return;
      // The pane's current size, for when this client does not pin it.
      const queryPaneSize = async (): Promise<{ cols: number; rows: number } | null> => {
        try {
          const sizeOut = await tmux(["display-message", "-p", "-t", `${sessionName}:0`, "#{window_width}|#{window_height}"]);
          if (sizeOut.code !== 0) return null;
          const parts = sizeOut.stdout.split("|").map(Number);
          const nc = parts[0] ?? NaN;
          const nr = parts[1] ?? NaN;
          if (Number.isFinite(nc) && Number.isFinite(nr) && nc > 0 && nr > 0) return { cols: nc, rows: nr };
          logger.warn({ session: sessionName, raw: sizeOut.stdout }, "viewport query returned invalid size");
        } catch (e) {
          logger.warn({ session: sessionName, err: e }, "viewport query failed");
        }
        return null;
      };

      if (attachCount === 0 && ws.data.pin) {
        try { await pinViewport(sessionName, cols, rows); pinnedBy(ws, cols, rows); }
        catch (e) {
          logger.warn({ session: sessionName, connId, err: e }, "viewport pin failed");
          try { ws.send(`[hub] viewport pin failed: ${(e as Error).message}\n`); } catch {}
        }
        // R3: send viewport message — web owns
        try { ws.send(JSON.stringify({ kind: "viewport", cols, rows, owner: "web" })); } catch {}
      } else if (attachCount === 0) {
        // Hidden slot: web still owns (it may pin later), but snapshot at the
        // pane's real size so the attach stays aligned until then.
        const size = await queryPaneSize();
        if (size) { paneCols = size.cols; paneRows = size.rows; }
        try { ws.send(JSON.stringify({ kind: "viewport", cols: paneCols, rows: paneRows, owner: "web" })); } catch {}
      } else {
        logger.debug({ session: sessionName, attachCount }, "native client attached, skipping viewport pin");
        // R3: send viewport message — native owns, query current size
        const size = await queryPaneSize();
        if (size) {
          paneCols = size.cols;
          paneRows = size.rows;
          try { ws.send(JSON.stringify({ kind: "viewport", cols: size.cols, rows: size.rows, owner: "native" })); } catch {}
        }
      }

      let b: Awaited<ReturnType<typeof broadcasters.get>>;
      try {
        b = await broadcasters.get(sessionName);
      } catch (e) {
        logger.error({ session: sessionName, connId, err: e }, "broadcaster get failed; closing ws");
        try { ws.send(`[hub] broadcaster failed: ${(e as Error).message}\n`); } catch {}
        try { ws.close(1011, "broadcaster failed"); } catch {}
        return;
      }
      if (ws.data.closed) return;
      if (b.ring.truncated()) sse.emit({ event: "replay_truncated", payload: { name: sessionName } });
      ws.data.broadcaster = b;

      const unsubEvents = b.onEvent((ev) => {
        if (ev.kind === "replay_truncated") {
          sse.emit({ event: "replay_truncated", payload: { name: sessionName } });
        }
      });
      // Scroll memory + replay-done signal: sent AFTER replay bytes so the
      // client can apply it behind a parse barrier. 无条件发送——语义升级为
      // "replay-done 信号 + 记忆值"：client 的恢复决策（decideScrollRestore）
      // 需要稳定触发点，lfb=0/无记忆时 reconnect 回底同样依赖这条消息；
      // snapshot 是流式字节，client 侧没有结束标记可依赖。旧 client 对
      // lfb=0 消息天然忽略（其 shouldRestore 含 lfb > 0 条件），兼容。
      const sendReplayDone = (): void => {
        try {
          const lfb = managedDb.getScrollPos(sessionName);
          ws.send(JSON.stringify({ kind: "scrollpos", linesFromBottom: lfb ?? 0 }));
        } catch (e) {
          logger.warn({ session: sessionName, connId, err: e }, "scrollpos restore send failed");
        }
      };
      const sendData = (chunk: Uint8Array): void => { try { ws.send(chunk); } catch {} };
      let unsubData: (() => void) | null = null;
      const attached = b.attachWithReplay(sendData, paneCols, paneRows);
      if (ws.data.resyncCapable && !ws.data.closed) {
        // Same replay-done contract as the attach: the client snapshots its
        // scroll position on `resync` and restores it on the trailing scrollpos.
        ws.data.resync = new ResyncScheduler(paneCols, paneRows, attached, async (c, r) => {
          await b.resync(sendData, c, r, () => { try { ws.send(JSON.stringify({ kind: "resync" })); } catch {} });
          // resync re-subscribes; a close that raced it already ran the unsubs.
          if (ws.data.closed) { unsubData?.(); return; }
          sendReplayDone();
        });
      }
      try {
        unsubData = await attached;
      } catch (e) {
        unsubEvents();
        logger.error({ session: sessionName, connId, err: e }, "attach failed; closing ws");
        try { ws.close(1011, "attach failed"); } catch {}
        return;
      }
      if (!adoptUnsubs(ws.data, unsubEvents, unsubData)) return;
      peers.add(sessionName, ws);
      sendReplayDone();
    },
    async close(ws: ServerWebSocket<WsData>, code: number, reason: string) {
      connections--;
      const { sessionName, connId } = ws.data;
      logger.info({ session: sessionName, connId, code, reason: reason || undefined }, "ws close");
      ws.data.closed = true;
      ws.data.resync?.dispose();
      if (peers.remove(sessionName, ws)) released(ws);
      const { unsubs } = ws.data;
      for (const fn of unsubs) try { fn(); } catch {}
      ws.data.unsubs.length = 0;
    },
    message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
      const { sessionName, connId } = ws.data;
      let parsed: unknown;
      try {
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
        parsed = JSON.parse(text);
      } catch {
        logger.debug({ session: sessionName, connId }, "ws message: invalid json");
        try { ws.send(JSON.stringify({ error: "invalid json" })); } catch {}
        return;
      }
      if (typeof parsed === "object" && parsed !== null && (parsed as { kind?: string }).kind === "ping") {
        const ts = (parsed as { ts?: number }).ts ?? 0;
        try { ws.send(JSON.stringify({ kind: "pong", ts })); } catch {}
        return;
      }
      // Client render telemetry (opt-in via ?debug=perf): log and stop — never
      // forward to the pty. Lets us read real per-device render cadence from logs.
      if (typeof parsed === "object" && parsed !== null && (parsed as { kind?: string }).kind === "telemetry") {
        logger.info(
          { session: sessionName, connId, perf: (parsed as { payload?: unknown }).payload },
          "client perf telemetry",
        );
        return;
      }
      // Per-session scroll position memory (cross-device). Persist and stop —
      // never forward to the pty.
      if (typeof parsed === "object" && parsed !== null && (parsed as { kind?: string }).kind === "scrollpos") {
        const rawLfb = (parsed as { linesFromBottom?: unknown }).linesFromBottom;
        const lfb = clampInt(Number(rawLfb), 0, 10_000_000, 0);
        try { managedDb.setScrollPos(sessionName, lfb); } catch (e) {
          logger.warn({ session: sessionName, connId, err: e }, "scrollpos persist failed");
        }
        return;
      }
      input.send(sessionName, parsed as Parameters<typeof input.send>[1]).then((result) => {
        // If resize was skipped (native attached), send authoritative viewport back
        if (result?.skipped && result.cols && result.rows) {
          try {
            ws.send(JSON.stringify({ kind: "viewport", cols: result.cols, rows: result.rows, owner: "native" }));
          } catch {}
        } else if (!result?.skipped && result?.cols && result?.rows) {
          // Web resize applied → pane changed size; keep the emulator grid aligned
          // so later snapshots stay coherent at the new width.
          ws.data.broadcaster?.syncEmulatorSize(result.cols, result.rows);
          ws.data.resync?.resized(result.cols, result.rows);
          pinnedBy(ws, result.cols, result.rows);
        }
      }).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        if (e instanceof HubError && e.code === 410) {
          logger.warn({ session: sessionName, connId }, "input send: session gone");
          try { ws.close(4410, "session gone"); } catch {}
        } else {
          logger.error({ session: sessionName, connId, err: e }, "input send failed");
        }
        try { ws.send(JSON.stringify({ error: msg })); } catch {}
      });
    },
  };
}
