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

const BUILD_MARKER = "canvas-renderer-v9";

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
  try {
    term.loadAddon(new CanvasAddon());
  } catch (e) {
    console.warn("[tmux-hub] CanvasAddon failed to load, falling back to DOM:", e);
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

  const consumeOrPassThrough = (bytes: Uint8Array) => {
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
    // Skip prediction in alternate screen buffer. Full-screen TUIs (claude code,
    // vim, less, fzf) all switch to alt buffer via CSI ?1049h and render with
    // partial repaints; our predict-write moves xterm's internal cursor without
    // the app's knowledge, so when the app later draws its own cursor glyph
    // (e.g. ✏️ in claude code) at the model position, the old glyph at the
    // predicted position is left behind as residue (the 'white block').
    // Predictions only help shell-prompt typing where the shell echoes each
    // char back; full-screen apps don't echo so prediction has no benefit
    // and active downsides.
    if (term.buffer.active.type === "alternate") return;
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
