import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
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

export async function attachTerminal(opts: AttachOptions): Promise<TerminalHandle> {
  const term = new Terminal({
    convertEol: true,
    cursorBlink: !opts.readOnly,
    fontFamily: "ui-monospace, Menlo, monospace",
    fontSize: 13,
    theme: { background: "#1a1a1f" },
    cols: opts.cols ?? 200,
    rows: opts.rows ?? 50,
    disableStdin: opts.readOnly ?? false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  const el = document.createElement("div");
  el.className = "terminal-host";
  opts.parent.appendChild(el);
  term.open(el);
  try { fit.fit(); } catch { /* container size 0 in tests */ }

  const wsUrl = await hubWsUrl(`/ws/sessions/${encodeURIComponent(opts.sessionName)}`);
  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  ws.onmessage = (m) => {
    if (typeof m.data === "string") {
      // Hub may send JSON error frames as string
      try {
        const parsed = JSON.parse(m.data);
        if (parsed && typeof parsed === "object" && "error" in parsed) {
          term.write(`\r\n[hub] ${(parsed as { error: string }).error}\r\n`);
          return;
        }
      } catch { /* fall through and write raw */ }
      term.write(m.data);
    } else {
      term.write(new Uint8Array(m.data as ArrayBuffer));
    }
  };

  ws.onclose = () => term.write("\r\n[hub] connection closed\r\n");
  ws.onerror = () => term.write("\r\n[hub] connection error\r\n");

  const send = (msg: ClientWsMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
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
