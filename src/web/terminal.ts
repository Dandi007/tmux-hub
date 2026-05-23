import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { CanvasAddon } from "xterm-addon-canvas";
import { attachMomentumScroll } from "./momentum-scroll";
import "xterm/css/xterm.css";
import type { ClientWsMessage } from "@shared/protocol";
import { hubWsUrl, refreshSecret } from "./hub-fetch";

export type TerminalState = "connected" | "reconnecting" | "dead";

export type TerminalHandle = {
  el: HTMLElement;
  send: (msg: ClientWsMessage) => void;
  close: () => void;
  probeNow: () => void;
  retry: () => void;
  readonly isConnected: boolean;
  readonly state: TerminalState;
  onStateChange: (cb: (state: TerminalState, attempt?: number) => void) => void;
};

export type AttachOptions = {
  sessionName: string;
  parent: HTMLElement;
  readOnly?: boolean;
  cols?: number;
  rows?: number;
};

const BUILD_MARKER = "tui-cursor-gate-v10";

const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS  = 5_000;
const RECONNECT_MAX_RETRIES = 8;
const RECONNECT_BASE_MS     = 500;
const RECONNECT_MAX_MS      = 30_000;
const RECONNECT_JITTER      = 0.3;
const DEAD_PROBE_INTERVAL_MS = 60_000;
const SEND_QUEUE_MAX_BYTES  = 65_536;

export async function attachTerminal(opts: AttachOptions): Promise<TerminalHandle> {
  console.log(`[tmux-hub] ${BUILD_MARKER} attaching to ${opts.sessionName}`);
  // Disposed gate — hoisted to the top so the deferred CanvasAddon load
  // and any straggler ws callbacks can skip when the caller has already
  // torn this attach down (mobile session switch race).
  let disposed = false;
  const term = new Terminal({
    convertEol: true,
    cursorBlink: false,
    cursorStyle: "underline",          // focused cursor: subtle 1px underline
    cursorInactiveStyle: "none",       // blur state: hide cursor entirely (was 'outline' = the white block)
    fontFamily: "ui-monospace, Menlo, monospace",
    fontSize: 13,
    theme: {
      background: "#1a1a1f",
      // xterm.js 5.x DOM renderer paints the cursor cell's background with
      // theme.cursor regardless of cursorStyle (block/underline/bar). Setting
      // cursor to the background color makes the cell invisible. We rely on
      // typed-character position + TUI apps' own cursor glyphs (claude code ✏️,
      // vim's own cursor) for cursor-position feedback.
      cursor: "#1a1a1f",
      cursorAccent: "#1a1a1f",
    },
    cols: opts.cols ?? 200,
    rows: opts.rows ?? 50,
    disableStdin: opts.readOnly ?? false,
    scrollback: 5000,
    smoothScrollDuration: 0,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  const el = document.createElement("div");
  el.className = "terminal-host";
  opts.parent.appendChild(el);
  term.open(el);

  // Use the canvas renderer addon instead of xterm's default DOM renderer.
  // The DOM renderer paints cursor cells via theme.cursor color slot in a way
  // that several mitigation rounds (cursorStyle, cursorInactiveStyle,
  // theme.cursor=bg, CSS !important) could not suppress. The canvas renderer
  // owns its own cell-painting path and has been observed to draw the cursor
  // as a real underline/bar without bleeding the cursor color over the cell
  // background. If WebGL context-loss-style issues recur, this can be swapped
  // back to DOM by removing the addon.
  // CanvasAddon is loaded with a small setTimeout deferral so xterm has time
  // to finish wiring _renderService before the addon subscribes. Without the
  // deferral, second+ attaches (mobile session switch) trigger
  // `Cannot read properties of undefined (reading 'onRequestRedraw')`.
  //
  // We load it for read-only views too — the canvas renderer composites
  // visible cells onto a single GPU layer, which on iOS Safari gives much
  // smoother touch-scroll than the default DOM renderer (every scroll
  // pixel under DOM mutates dozens of <span>s and stalls the main thread).
  // The session-switch race that originally motivated the readOnly skip is
  // now contained by the disposed-guard + serial transition queue.
  setTimeout(() => {
    if (disposed) return;
    try {
      term.loadAddon(new CanvasAddon());
    } catch (e) {
      console.warn("[tmux-hub] CanvasAddon failed to load, falling back to DOM:", e);
    }
  }, 50);

  // Intercept DECSCUSR (CSI Ps SP q) so TUI apps cannot force cursorStyle back to
  // block at runtime. Returning true marks the sequence as handled, so xterm's
  // built-in handler does NOT mutate term.options.cursorStyle.
  // Format: \x1b[<n> q  where n in {0..6}. The space before `q` is the
  // intermediate byte; xterm's parser uses { final: 'q', intermediates: ' ' }.
  try {
    term.parser.registerCsiHandler({ final: "q", intermediates: " " }, () => true);
  } catch (e) {
    console.warn("[tmux-hub] DECSCUSR intercept failed:", e);
  }

  try { fit.fit(); } catch { /* container size 0 in tests */ }

  // Attach custom touch-momentum scroll. Listener goes on the OUTER
  // terminal-host (el) so touches anywhere — over the canvas, over the
  // viewport gutter, even over the helper textarea — bubble to it. The
  // scrollTop target is .xterm-viewport, which is xterm's actual
  // scrollable element. Listening on .xterm-viewport directly only
  // catches touches over the narrow scrollbar gutter on the right edge
  // because .xterm-screen sits on top of it in the z-order as a sibling
  // and intercepts touches in the body of the terminal.
  let detachMomentum: (() => void) | null = null;
  if ("ontouchstart" in window) {
    const viewport = el.querySelector<HTMLElement>(".xterm-viewport");
    if (viewport) detachMomentum = attachMomentumScroll(el, viewport);
  }

  // Once `close()` is called we MUST stop touching `term`. Any write into a
  // disposed xterm tunnels into `_renderService.onRequestRedraw` and throws
  // "Cannot read properties of undefined", which on mobile leaves the new
  // xterm without a renderer (the underlying root-cause of "切换 session 后
  // 不 attach" flakes — straggler ws.onmessage/onclose/onerror events from
  // the OUTGOING term land while the INCOMING term is being constructed,
  // and the uncaught throw aborts xterm's renderer wiring).
  // `disposed` is hoisted to the top of attachTerminal.
  const writeTerm = (data: string | Uint8Array): void => {
    if (disposed) return;
    try { term.write(data); } catch (e) {
      // Last line of defence; should not happen with the disposed gate.
      console.warn("[tmux-hub] term.write failed:", e);
    }
  };

  // Predictive local-echo queue: each entry is a byte we've already drawn locally
  // for instant feedback. When the server's echo of that byte arrives, consume it
  // (don't render again). Stale predictions are dropped after PREDICT_TIMEOUT_MS.
  type Prediction = { byte: number; ts: number };
  const predictions: Prediction[] = [];
  const PREDICT_TIMEOUT_MS = 2000;
  const isPrintable = (c: number) => c >= 0x20 && c < 0x7f;

  // Track when the server last emitted a cursor-positioning escape sequence
  // (anything ESC[<params><final> with final != 'm'). When this is recent,
  // the server is rendering with absolute or relative cursor moves (a TUI
  // mode like claude code) and our predictive local echo would race with
  // it — predicting characters moves xterm's cursor under the server's
  // feet, so the server's next relative move lands in the wrong cell and
  // old reverse cells are never overwritten. Shell prompts only emit SGR
  // ('m') for color, which we deliberately exclude so shell typing keeps
  // its instant local echo.
  let lastTuiPositioningTs = 0;
  const TUI_GATE_WINDOW_MS = 1500;
  const detectCursorPositioning = (data: Uint8Array): boolean => {
    let i = 0;
    while (i < data.length - 1) {
      if (data[i] === 0x1b && data[i + 1] === 0x5b /* [ */) {
        let j = i + 2;
        while (j < data.length) {
          const b = data[j]!;
          // params: 0-9, ; , ? > = <
          if (b >= 0x30 && b <= 0x3f) { j++; continue; }
          // final byte (0x40-0x7e). Exclude 'm' (SGR) since shells use it.
          if (b >= 0x40 && b <= 0x7e && b !== 0x6d /* m */) return true;
          break;
        }
        i = j + 1;
      } else {
        i++;
      }
    }
    return false;
  };

  const consumeOrPassThrough = (bytes: Uint8Array) => {
    if (disposed) return;
    if (detectCursorPositioning(bytes)) lastTuiPositioningTs = Date.now();
    if (predictions.length === 0) { writeTerm(bytes); return; }
    const now = Date.now();
    const out: number[] = [];
    for (const byte of bytes) {
      while (predictions.length > 0 && now - predictions[0]!.ts > PREDICT_TIMEOUT_MS) {
        predictions.shift();
      }
      if (predictions.length > 0 && predictions[0]!.byte === byte) {
        predictions.shift();
      } else {
        out.push(byte);
      }
    }
    if (out.length > 0) writeTerm(new Uint8Array(out));
  };

  const predictLocalEcho = (data: string): void => {
    // Skip prediction whenever the server is in TUI rendering mode. Two
    // signals:
    //   1. xterm reports the alternate screen buffer is active (vim, less,
    //      fzf etc. switch via CSI ?1049h)
    //   2. recent server bytes contained a cursor-positioning escape with
    //      a final byte other than 'm' (claude code in particular runs on
    //      the normal buffer but renders with CSI<n>A/B/C/D/G/H/K/...)
    // Without (2) claude code escapes the gate and our predict-write races
    // its partial repaints, leaving stale reverse cells (the white block).
    // Shell prompt echo only emits ESC[<n>m (SGR for color), which is
    // deliberately excluded so shell typing stays instant.
    if (term.buffer.active.type === "alternate") return;
    if (Date.now() - lastTuiPositioningTs < TUI_GATE_WINDOW_MS) return;
    if (data.length !== 1) return;
    const byte = data.charCodeAt(0);
    if (!isPrintable(byte)) return;
    predictions.push({ byte, ts: Date.now() });
    writeTerm(data);
  };

  // ── State machine ──────────────────────────────────────────────────
  let currentState: TerminalState = "connected";
  let stateListeners: Array<(state: TerminalState, attempt?: number) => void> = [];
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let deadProbeTimer: ReturnType<typeof setInterval> | null = null;

  const setState = (next: TerminalState, attempt?: number): void => {
    if (next === currentState && next !== "reconnecting") return;
    currentState = next;
    for (const cb of stateListeners) {
      try { cb(next, attempt); } catch {}
    }
  };

  // ── Heartbeat ──────────────────────────────────────────────────────
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let pongTimer: ReturnType<typeof setTimeout> | null = null;

  const stopHeartbeat = (): void => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
  };

  const sendPing = (): void => {
    if (disposed || currentState !== "connected") return;
    try { ws.send(JSON.stringify({ kind: "ping", ts: Date.now() })); } catch {}
    if (pongTimer) clearTimeout(pongTimer);
    pongTimer = setTimeout(() => {
      pongTimer = null;
      if (disposed || currentState !== "connected") return;
      console.warn("[tmux-hub] heartbeat timeout — entering reconnect");
      enterReconnecting();
    }, HEARTBEAT_TIMEOUT_MS);
  };

  const startHeartbeat = (): void => {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (disposed || currentState !== "connected") return;
      sendPing();
    }, HEARTBEAT_INTERVAL_MS);
  };

  const receivePong = (): void => {
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
  };

  // ── Send queue ─────────────────────────────────────────────────────
  let sendQueue: string[] = [];
  let sendQueueBytes = 0;

  const queuedSend = (msg: ClientWsMessage): void => {
    if (disposed) return;
    if (currentState === "connected" && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return;
    }
    if (currentState === "dead") return;
    const json = JSON.stringify(msg);
    const byteLen = json.length;
    while (sendQueueBytes + byteLen > SEND_QUEUE_MAX_BYTES && sendQueue.length > 0) {
      sendQueueBytes -= sendQueue.shift()!.length;
    }
    sendQueue.push(json);
    sendQueueBytes += byteLen;
  };

  const flushSendQueue = (): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    for (const json of sendQueue) {
      try { ws.send(json); } catch { break; }
    }
    sendQueue = [];
    sendQueueBytes = 0;
  };

  // ── WS wiring + reconnect logic ───────────────────────────────────
  const wireWs = (socket: WebSocket): void => {
    socket.binaryType = "arraybuffer";
    socket.onmessage = (m) => {
      if (disposed) return;
      if (typeof m.data === "string") {
        try {
          const parsed = JSON.parse(m.data);
          if (parsed && typeof parsed === "object") {
            if ("kind" in parsed && (parsed as { kind: string }).kind === "pong") {
              receivePong();
              return;
            }
            if ("error" in parsed) {
              writeTerm(`\r\n[hub] ${(parsed as { error: string }).error}\r\n`);
              return;
            }
          }
        } catch { /* fall through */ }
        consumeOrPassThrough(new TextEncoder().encode(m.data));
      } else {
        consumeOrPassThrough(new Uint8Array(m.data as ArrayBuffer));
      }
    };
    socket.onclose = () => {
      if (disposed) return;
      if (currentState === "connected") {
        console.warn("[tmux-hub] ws closed unexpectedly — entering reconnect");
        enterReconnecting();
      }
    };
    socket.onerror = () => {};
  };

  const buildWsUrl = async (): Promise<string> => {
    try { fit.fit(); } catch {}
    const c = term.cols > 0 ? term.cols : (opts.cols ?? 200);
    const r = term.rows > 0 ? term.rows : (opts.rows ?? 50);
    const base = await hubWsUrl(`/ws/sessions/${encodeURIComponent(opts.sessionName)}`);
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}cols=${c}&rows=${r}`;
  };

  const enterReconnecting = (): void => {
    if (disposed) return;
    console.log(`[tmux-hub] entering reconnect for ${opts.sessionName}`);
    stopHeartbeat();
    try { ws.onmessage = null; ws.onclose = null; ws.onerror = null; ws.close(); } catch {}
    predictions.length = 0;
    reconnectAttempt = 0;
    setState("reconnecting", 0);
    scheduleReconnectAttempt();
  };

  const scheduleReconnectAttempt = (): void => {
    if (disposed) return;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt), RECONNECT_MAX_MS);
    const jittered = delay * (1 + (Math.random() * 2 - 1) * RECONNECT_JITTER);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void attemptReconnect();
    }, jittered);
  };

  const attemptReconnect = async (): Promise<void> => {
    if (disposed) return;
    reconnectAttempt++;
    console.log(`[tmux-hub] reconnect attempt ${reconnectAttempt}/${RECONNECT_MAX_RETRIES} for ${opts.sessionName}`);
    setState("reconnecting", reconnectAttempt);

    let url: string;
    try {
      await refreshSecret();
      url = await buildWsUrl();
    } catch (e) {
      console.error(`[tmux-hub] reconnect: token/url build failed`, e);
      setState("dead");
      startDeadProbe();
      return;
    }
    console.log(`[tmux-hub] reconnect: opening ws`);

    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";

    const connectTimeout = setTimeout(() => {
      console.warn(`[tmux-hub] reconnect: connect timeout (${HEARTBEAT_TIMEOUT_MS}ms)`);
      try { socket.close(); } catch {}
    }, HEARTBEAT_TIMEOUT_MS);

    socket.onopen = () => {
      clearTimeout(connectTimeout);
      if (disposed) { try { socket.close(); } catch {} return; }
      console.log(`[tmux-hub] reconnect: ws open — success`);
      ws = socket;
      wireWs(ws);
      reconnectAttempt = 0;
      predictions.length = 0;
      setState("connected");
      flushSendQueue();
      startHeartbeat();
      const c = term.cols;
      const r = term.rows;
      if (c > 0 && r > 0) queuedSend({ kind: "resize", cols: c, rows: r });
    };

    socket.onclose = (ev) => {
      clearTimeout(connectTimeout);
      console.warn(`[tmux-hub] reconnect: ws closed code=${ev.code} reason=${ev.reason}`);
      if (disposed) return;
      if (reconnectAttempt >= RECONNECT_MAX_RETRIES) {
        console.error(`[tmux-hub] reconnect: max retries reached — dead`);
        setState("dead");
        startDeadProbe();
      } else {
        scheduleReconnectAttempt();
      }
    };
    socket.onerror = (ev) => {
      console.error(`[tmux-hub] reconnect: ws error`, ev);
    };
  };

  const startDeadProbe = (): void => {
    stopDeadProbe();
    deadProbeTimer = setInterval(() => {
      if (disposed || currentState !== "dead") { stopDeadProbe(); return; }
      stopDeadProbe();
      reconnectAttempt = 0;
      setState("reconnecting", 0);
      scheduleReconnectAttempt();
    }, DEAD_PROBE_INTERVAL_MS);
  };

  const stopDeadProbe = (): void => {
    if (deadProbeTimer) { clearInterval(deadProbeTimer); deadProbeTimer = null; }
  };

  // ── Resize ─────────────────────────────────────────────────────────
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const publishResize = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      const c = term.cols;
      const r = term.rows;
      if (c > 0 && r > 0) queuedSend({ kind: "resize", cols: c, rows: r });
    }, 150);
  };

  const onResize = () => {
    try { fit.fit(); } catch {}
    publishResize();
  };
  window.addEventListener("resize", onResize);

  // ── Initial WS connection ──────────────────────────────────────────
  const initUrl = await buildWsUrl();
  let ws = new WebSocket(initUrl);
  wireWs(ws);

  ws.addEventListener("open", () => {
    startHeartbeat();
    setTimeout(() => {
      const c = term.cols;
      const r = term.rows;
      if (c > 0 && r > 0 && ws.readyState === WebSocket.OPEN) {
        queuedSend({ kind: "resize", cols: c, rows: r });
      }
    }, 100);
  });

  if (!opts.readOnly) {
    // Desktop single input path per spec §设计原则 / Spike S2: only term.onData raw bytes,
    // NO attachCustomKeyEventHandler / keyEventToTmuxToken (those would double-send).
    term.onData((data) => {
      predictLocalEcho(data);
      queuedSend({ kind: "keys", literal: data });
    });
  }

  return {
    el,
    send: queuedSend,
    get isConnected() { return !disposed && currentState === "connected"; },
    get state() { return currentState; },
    onStateChange: (cb) => { stateListeners.push(cb); },
    probeNow: () => {
      if (disposed) return;
      if (currentState === "reconnecting") return;
      if (currentState === "dead") {
        stopDeadProbe();
        reconnectAttempt = 0;
        setState("reconnecting", 0);
        scheduleReconnectAttempt();
        return;
      }
      sendPing();
    },
    retry: () => {
      if (disposed || currentState !== "dead") return;
      stopDeadProbe();
      reconnectAttempt = 0;
      setState("reconnecting", 0);
      scheduleReconnectAttempt();
    },
    close: () => {
      disposed = true;
      stopHeartbeat();
      stopDeadProbe();
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      window.removeEventListener("resize", onResize);
      if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null; }
      try { detachMomentum?.(); } catch {}
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try { ws.close(); } catch {}
      try { term.dispose(); } catch {}
      try { el.remove(); } catch {}
      stateListeners = [];
    },
  };
}
