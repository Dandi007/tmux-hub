// src/server/output-broadcaster.ts
// S1b: pipe-pane redirects to an append-only log file; a polling reader holds a
// byte offset so kill/restart resumes without dropping bytes. See work folder
// for spike S1a/S1b analysis.
import { tmux } from "./tmux-cmd";
import { RingBuffer } from "./ring-buffer";
import {
  RING_BUFFER_BYTES,
  REPLAY_CAP_BYTES,
  EMULATOR_ENABLED,
  PIPE_SINK_CMD,
  SNAPSHOT_SCROLLBACK_LINES,
  WINDOW_COLS,
  WINDOW_ROWS,
} from "./config";
import { SessionEmulator } from "./session-emulator";
import { mkdirSync, openSync, readSync, closeSync, existsSync, unlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createLogger } from "./logger";

const logger = createLogger("broadcaster");

const LOG_DIR = process.env.TMUX_HUB_LOG_DIR
  ? resolve(process.env.TMUX_HUB_LOG_DIR)
  : resolve(homedir(), ".cache/tmux-hub/logs");

type Subscriber = (chunk: Uint8Array) => void;

export type BroadcasterEvent =
  | { kind: "replay_truncated" }
  | { kind: "stopped" }
  | { kind: "error"; message: string };

type EventListener = (event: BroadcasterEvent) => void;

export type TmuxRunner = (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;

export class SessionBroadcaster {
  readonly ring: RingBuffer;
  readonly logPath: string;
  private fd: number | null = null;
  private offset = 0;
  private emulator: SessionEmulator | null = null;
  private subscribers = new Set<Subscriber>();
  private eventListeners = new Set<EventListener>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private pollChunk = new Uint8Array(65536);

  // emulatorEnabled defaults to the module-level config flag (production wiring);
  // it is an explicit constructor seam only so tests can pin the path
  // deterministically without depending on cross-file env/module-cache ordering.
  constructor(
    public readonly session: string,
    private run: TmuxRunner = tmux,
    private readonly emulatorEnabled: boolean = EMULATOR_ENABLED,
  ) {
    this.ring = new RingBuffer(RING_BUFFER_BYTES);
    mkdirSync(LOG_DIR, { recursive: true });
    const safe = session.replace(/[^a-zA-Z0-9_-]/g, "_");
    // Stable per-session log file. Persists across attaches and hub restarts
    // so that history captured while no client is connected is preserved.
    this.logPath = resolve(LOG_DIR, `${safe}.log`);
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error("broadcaster already stopped; create a new instance");
    if (this.fd !== null || this.pollTimer !== null) return;
    // Idempotent: ensure pipe is off, then on. The `-o` flag is a toggle when used
    // without a shell command; we deliberately call it twice (once to turn off any
    // pre-existing pipe, then once to turn ours on with a redirect).
    await this.run(["pipe-pane", "-o", "-t", `${this.session}:0.0`]).catch(() => undefined);
    // PIPE_SINK_CMD must flush per read (not line-buffer); see config.ts. A
    // line-buffered sink (uutils cat) batches Claude's newline-sparse redraws
    // into ~1.7s lumps, making the browser clock jump every few seconds.
    const shellCmd = `${PIPE_SINK_CMD} >> ${shellQuote(this.logPath)}`;
    const r = await this.run(["pipe-pane", "-t", `${this.session}:0.0`, shellCmd]);
    if (r.code !== 0) {
      logger.error({ session: this.session, code: r.code, stderr: r.stderr }, "pipe-pane failed");
      throw new Error(`pipe-pane failed (${r.code}): ${r.stderr}`);
    }
    if (!existsSync(this.logPath)) {
      // Touch so we can open for read even before tmux writes the first byte.
      closeSync(openSync(this.logPath, "a"));
    }
    this.fd = openSync(this.logPath, "r");
    this.offset = 0;
    this.pollTimer = setInterval(() => { this.poll(); }, 5);
    logger.info({ session: this.session, logPath: this.logPath }, "broadcaster started");
  }

  // Lazily build the emulator on first attach, sized to the ACTUAL pane width.
  // The pipe-pane byte stream is width-specific — it was rendered by the app for
  // the current pane size — so the emulator MUST match that width or every wide
  // rule wraps and every absolute cursor move clamps, corrupting the snapshot.
  // Prime it from the current log tail so the snapshot reflects existing
  // history; xterm keeps only the last `scrollback` lines. A later attach may
  // re-pin the pane to a new size, so an existing emulator is resized to track
  // it. (Mid-stream reflow of already-captured history lands in P1.)
  private ensureEmulator(cols: number, rows: number): SessionEmulator {
    if (this.emulator) {
      this.emulator.resize(cols, rows);
      return this.emulator;
    }
    const e = new SessionEmulator(cols, rows, SNAPSHOT_SCROLLBACK_LINES);
    if (this.fd !== null && this.offset > 0) {
      const cap = REPLAY_CAP_BYTES;
      const start = Math.max(0, this.offset - cap);
      const len = this.offset - start;
      if (len > 0) {
        const buf = new Uint8Array(len);
        try {
          readSync(this.fd, buf, 0, len, start);
          // Starting at a line boundary avoids mid-line corruption. A residual
          // mid-escape-sequence risk across the newline is rare and the visible
          // screen (end of stream) is always correct; a fully clean rebuild from
          // byte 0 is a possible P1 refinement.
          if (start > 0) {
            const nlIdx = buf.indexOf(0x0a);
            e.write(nlIdx !== -1 ? buf.subarray(nlIdx + 1) : buf);
          } else {
            e.write(buf);
          }
        } catch (err) {
          logger.warn({ session: this.session, err }, "emulator prime read failed");
        }
      }
    }
    this.emulator = e;
    return e;
  }

  attach(send: Subscriber): () => void {
    this.subscribers.add(send);
    return () => { this.subscribers.delete(send); };
  }

  // Authoritative restore stream for the visible screen + scrollback, sourced
  // from `tmux capture-pane` — which tmux reflows to the pane's CURRENT size —
  // rather than replaying the width-frozen pipe-pane log. Replaying history
  // authored at a different width corrupts a non-alt-screen TUI (wide rules
  // wrap and overlay text, in-place redraw frames stack). capture-pane sidesteps
  // that entirely: the snapshot always matches the live pane size the client was
  // just pinned to. `-J` joins wrapped lines so the client re-wraps to its own
  // width; `-e` keeps SGR colors. capture-pane emits LF-separated lines, so we
  // convert to CRLF before feeding xterm (no implicit carriage return otherwise).
  // DEC private modes are not captured by tmux, so we append the emulator's
  // shadow-tracked modes. Falls back to the emulator serialize if capture fails.
  private async captureSnapshot(cols: number, rows: number): Promise<string> {
    const emu = this.ensureEmulator(cols, rows); // keep shadow primed + live-fed for modes
    try {
      const r = await this.run([
        "capture-pane", "-e", "-p", "-J",
        "-t", `${this.session}:0.0`,
        "-S", `-${SNAPSHOT_SCROLLBACK_LINES}`,
      ]);
      if (r.code === 0) {
        const body = r.stdout.replace(/\r?\n/g, "\r\n");
        return "\x1bc" + body + emu.serializeModes();
      }
      logger.warn(
        { session: this.session, code: r.code, stderr: r.stderr },
        "capture-pane failed; falling back to emulator snapshot",
      );
    } catch (e) {
      logger.warn({ session: this.session, err: e }, "capture-pane threw; falling back to emulator snapshot");
    }
    return emu.snapshot();
  }

  // Replay buffered history (tail of log file up to REPLAY_CAP bytes) then
  // attach for live updates. Bytes that arrive during the replay read are
  // buffered into a tap and flushed AFTER the history so that the subscriber
  // sees a strict 0->now byte order. Subscriber is then attached for live.
  // `paneCols`/`paneRows` are the authoritative pane size the caller just pinned
  // the tmux window to (or the native owner's size). The emulator is built/kept
  // at that size; invalid/omitted values fall back to the WINDOW_* defaults.
  async attachWithReplay(send: Subscriber, paneCols?: number, paneRows?: number): Promise<() => void> {
    if (this.fd === null) {
      // Broadcaster hasn't started — fall back to plain attach.
      this.subscribers.add(send);
      return () => { this.subscribers.delete(send); };
    }
    const pending: Uint8Array[] = [];
    const tap = (chunk: Uint8Array): void => { pending.push(chunk); };
    // Register the tap BEFORE capturing so every live byte emitted after this
    // point lands in `pending`; the capture reflects state at/after this moment,
    // so the overlap is at most a few self-correcting bytes and there is no gap.
    this.subscribers.add(tap);

    const enc = new TextEncoder();
    try {
      if (this.emulatorEnabled) {
        // Authoritative snapshot from tmux capture-pane (correctly reflowed to
        // the live pane size); live bytes during the async capture are buffered
        // by `tap` and flushed below in order.
        const cols = normalizeDim(paneCols, WINDOW_COLS);
        const rows = normalizeDim(paneRows, WINDOW_ROWS);
        const snap = await this.captureSnapshot(cols, rows);
        send(enc.encode(snap));
      } else {
        const upTo = this.offset;
        const start = Math.max(0, upTo - REPLAY_CAP_BYTES);
        const len = upTo - start;
        // RIS reset clears the terminal state. If we sliced mid-sequence at
        // `start`, xterm may briefly mis-render the first cells; acceptable
        // trade-off vs unbounded replay.
        send(enc.encode("\x1bc"));
        if (len > 0) {
          const buf = new Uint8Array(len);
          readSync(this.fd, buf, 0, len, start);
          send(buf);
        }
      }
    } catch (e) {
      logger.error({ session: this.session, err: e }, "replay/snapshot read failed");
      for (const l of this.eventListeners) l({ kind: "error", message: `replay: ${String(e)}` });
    } finally {
      this.subscribers.delete(tap);
    }
    // Flush any live bytes that landed during replay, in order.
    for (const chunk of pending) {
      try { send(chunk); } catch { /* swallow per-subscriber */ }
    }
    this.subscribers.add(send);
    return () => { this.subscribers.delete(send); };
  }

  // Re-size the live emulator to track a pane resize (client viewport change).
  // No-op until the emulator is lazily built on first attach — the next attach
  // builds it at the then-current pane size anyway.
  syncEmulatorSize(cols: number, rows: number): void {
    if (this.emulator && Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) {
      this.emulator.resize(Math.floor(cols), Math.floor(rows));
    }
  }

  onEvent(fn: EventListener): () => void {
    this.eventListeners.add(fn);
    return () => { this.eventListeners.delete(fn); };
  }

  subscriberCount(): number { return this.subscribers.size; }

  bytesBroadcast(): number { return this.ring.bytesWritten(); }

  async stop(opts: { deleteLog?: boolean } = {}): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    logger.info({ session: this.session, deleteLog: !!opts.deleteLog }, "broadcaster stopping");
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.fd !== null) { try { closeSync(this.fd); } catch { /* ignore */ } this.fd = null; }
    if (this.emulator) { this.emulator.dispose(); this.emulator = null; }
    await this.run(["pipe-pane", "-o", "-t", `${this.session}:0.0`]).catch(() => undefined);
    // Default: KEEP the log file so history persists across hub restarts.
    // Only delete when the underlying tmux session is gone (caller passes
    // deleteLog: true from the session_removed handler).
    if (opts.deleteLog) {
      try { if (existsSync(this.logPath)) unlinkSync(this.logPath); } catch { /* ignore */ }
    }
    for (const l of this.eventListeners) l({ kind: "stopped" });
    this.subscribers.clear();
    this.eventListeners.clear();
  }

  private poll(): void {
    if (this.fd === null) return;
    try {
      const st = statSync(this.logPath);
      if (st.size < this.offset) {
        for (const l of this.eventListeners) l({ kind: "replay_truncated" });
        this.offset = st.size;
        return;
      }
      while (true) {
        const n = readSync(this.fd, this.pollChunk, 0, this.pollChunk.length, this.offset);
        if (n <= 0) break;
        this.offset += n;
        const chunk = new Uint8Array(this.pollChunk.subarray(0, n));
        const wasTruncated = this.ring.truncated();
        this.ring.append(chunk);
        if (this.emulator) this.emulator.write(chunk);
        if (!wasTruncated && this.ring.truncated()) {
          for (const l of this.eventListeners) l({ kind: "replay_truncated" });
        }
        for (const sub of this.subscribers) {
          try { sub(chunk); } catch { /* swallow subscriber errors */ }
        }
        if (n < this.pollChunk.length) break;
      }
    } catch (e) {
      logger.error({ session: this.session, err: e }, "poll read error");
      for (const l of this.eventListeners) l({ kind: "error", message: String(e) });
    }
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// A positive finite integer, or the fallback. Used to resolve attach-time pane
// dimensions before building the emulator.
function normalizeDim(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

export class BroadcasterRegistry {
  private map = new Map<string, SessionBroadcaster>();

  constructor(private run: TmuxRunner = tmux, private emulatorEnabled?: boolean) {}

  async get(session: string): Promise<SessionBroadcaster> {
    const existing = this.map.get(session);
    if (existing) return existing;
    const b = new SessionBroadcaster(session, this.run, this.emulatorEnabled);
    this.map.set(session, b);
    await b.start();
    return b;
  }

  has(session: string): boolean { return this.map.has(session); }

  async stop(session: string, opts: { deleteLog?: boolean } = {}): Promise<void> {
    const b = this.map.get(session);
    if (!b) return;
    this.map.delete(session);
    await b.stop(opts);
  }

  async stopAll(): Promise<void> {
    const all = Array.from(this.map.values());
    this.map.clear();
    await Promise.allSettled(all.map((b) => b.stop()));
  }
}
