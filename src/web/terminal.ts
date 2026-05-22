import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { WebglAddon } from "xterm-addon-webgl";
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

const BUILD_MARKER = "predictive-echo-v2";

export async function attachTerminal(opts: AttachOptions): Promise<TerminalHandle> {
  console.log(`[tmux-hub] ${BUILD_MARKER} attaching to ${opts.sessionName}`);
  const term = new Terminal({
    convertEol: true,
    cursorBlink: false,            // disabled — no constant repaint, reduces flicker
    fontFamily: "ui-monospace, Menlo, monospace",
    fontSize: 13,
    theme: { background: "#1a1a1f" },
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

  // GPU-accelerated renderer for snappier paints, falls back to canvas on context loss.
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => { try { webgl.dispose(); } catch {} });
    term.loadAddon(webgl);
  } catch (e) {
    console.warn("[tmux-hub] WebGL renderer unavailable, falling back:", e);
  }

  try { fit.fit(); } catch { /* container size 0 in tests */ }

  const wsUrl = await hubWsUrl(`/ws/sessions/${encodeURIComponent(opts.sessionName)}`);
  const ws = new WebSocket(wsUrl);
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
    // Only predict single printable ASCII chars. CJK / control / multi-byte / paste
    // chunks fall through to "wait for server" — no prediction queue entry.
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
