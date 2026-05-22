import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { CanvasAddon } from "xterm-addon-canvas";
import "xterm/css/xterm.css";
import type { ClientWsMessage } from "@shared/protocol";
import { hubWsUrl } from "./hub-fetch";

export type TerminalHandle = {
  el: HTMLElement;
  send: (msg: ClientWsMessage) => void;
  close: () => void;
};

export type AttachOptions = {
  sessionName: string;
  parent: HTMLElement;
  readOnly?: boolean;
  cols?: number;
  rows?: number;
};

const BUILD_MARKER = "tui-cursor-gate-v10";

export async function attachTerminal(opts: AttachOptions): Promise<TerminalHandle> {
  console.log(`[tmux-hub] ${BUILD_MARKER} attaching to ${opts.sessionName}`);
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
  // CanvasAddon is loaded with a small setTimeout deferral. Synchronous /
  // rAF-deferred load races with xterm's _renderService setup on second+
  // attaches (mobile session switch reproduces: dispose → new Terminal →
  // open → loadAddon all in one tick triggers
  // `Cannot read properties of undefined (reading 'onRequestRedraw')`,
  // leaving xterm without a renderer). A small queueMicrotask + setTimeout
  // breaks out of the current task and lets xterm finish its renderer wiring
  // before the addon subscribes. We also skip loading the addon entirely in
  // readOnly mode — the canvas renderer was added to suppress a cursor
  // white-block during typed claude-code input, which read-only mirror views
  // can't trigger anyway.
  if (!opts.readOnly) {
    setTimeout(() => {
      try {
        term.loadAddon(new CanvasAddon());
      } catch (e) {
        console.warn("[tmux-hub] CanvasAddon failed to load, falling back to DOM:", e);
      }
    }, 50);
  }

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

  // Pass client's actual fit() result to the server via WS query so the server
  // pins tmux window-size to match BEFORE capturing the initial snapshot.
  // Without this the server pins to hardcoded 200x50, captures a 200-wide
  // snapshot, and xterm wraps it at client width (bug 2: prompt scroll-drift).
  const initCols = term.cols > 0 ? term.cols : (opts.cols ?? 200);
  const initRows = term.rows > 0 ? term.rows : (opts.rows ?? 50);
  const wsBase = await hubWsUrl(`/ws/sessions/${encodeURIComponent(opts.sessionName)}`);
  const sep = wsBase.includes("?") ? "&" : "?";
  const wsUrl = `${wsBase}${sep}cols=${initCols}&rows=${initRows}`;
  const ws = new WebSocket(wsUrl);
  console.log(`[tmux-hub] ws init cols=${initCols} rows=${initRows}`);
  ws.binaryType = "arraybuffer";

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
    if (detectCursorPositioning(bytes)) lastTuiPositioningTs = Date.now();
    if (predictions.length === 0) { term.write(bytes); return; }
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
    if (out.length > 0) term.write(new Uint8Array(out));
  };

  ws.onmessage = (m) => {
    if (typeof m.data === "string") {
      try {
        const parsed = JSON.parse(m.data);
        if (parsed && typeof parsed === "object" && "error" in parsed) {
          term.write(`\r\n[hub] ${(parsed as { error: string }).error}\r\n`);
          return;
        }
      } catch { /* fall through and write raw */ }
      consumeOrPassThrough(new TextEncoder().encode(m.data));
    } else {
      consumeOrPassThrough(new Uint8Array(m.data as ArrayBuffer));
    }
  };

  ws.onclose = () => term.write("\r\n[hub] connection closed\r\n");
  ws.onerror = () => term.write("\r\n[hub] connection error\r\n");

  const send = (msg: ClientWsMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
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
    term.write(data);
  };

  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const publishResize = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      const c = term.cols;
      const r = term.rows;
      if (c > 0 && r > 0 && ws.readyState === WebSocket.OPEN) {
        send({ kind: "resize", cols: c, rows: r });
      }
    }, 150);
  };

  const onResize = () => {
    try { fit.fit(); } catch {}
    publishResize();
  };
  window.addEventListener("resize", onResize);

  ws.addEventListener("open", () => {
    setTimeout(() => {
      const c = term.cols;
      const r = term.rows;
      if (c > 0 && r > 0 && ws.readyState === WebSocket.OPEN) {
        send({ kind: "resize", cols: c, rows: r });
      }
    }, 100);
  });

  if (!opts.readOnly) {
    // Desktop single input path per spec §设计原则 / Spike S2: only term.onData raw bytes,
    // NO attachCustomKeyEventHandler / keyEventToTmuxToken (those would double-send).
    term.onData((data) => {
      predictLocalEcho(data);
      send({ kind: "keys", literal: data });
    });
  }

  return {
    el,
    send,
    close: () => {
      window.removeEventListener("resize", onResize);
      if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null; }
      try { ws.close(); } catch {}
      term.dispose();
      el.remove();
    },
  };
}
