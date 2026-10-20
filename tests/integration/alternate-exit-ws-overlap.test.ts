import { test, expect } from "bun:test";
import { mkdtempSync, appendFileSync, rmSync } from "node:fs";
import { Terminal } from "@xterm/headless";
import { createWsHandlers, type WsData } from "../../src/server/ws-handlers";
const dir = mkdtempSync("/tmp/alt-ws-overlap-");
process.env.TMUX_HUB_LOG_DIR = dir;
const until = async (fn: () => boolean | Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (!await fn()) { if (Date.now() > end) throw new Error("timeout"); await Bun.sleep(5); }
};

test("exit repair recovers a five-capture LF overlap while redraws remain busy", async () => {
  const { SessionBroadcaster } = await import("../../src/server/output-broadcaster");
  const oracle = new Terminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true });
  const client = new Terminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true });
  const writeOracle = (data: string) => (oracle as any)._core.writeSync(data);
  writeOracle(Array.from({ length: 40 }, (_, i) => `STATIC ${i}`).join("\r\n") + "\r\n\x1b[?1049hALT");
  let b: InstanceType<typeof SessionBroadcaster>, forcing = false, captures = 0, ticks = 0;
  const emit = (data: string) => { writeOracle(data); appendFileSync(b.logPath, data); };
  const screen = (term: Terminal, normal = false) => {
    const buf = normal ? term.buffer.normal : term.buffer.active;
    return Array.from({ length: 24 }, (_, y) => buf.getLine(buf.baseY + y)?.translateToString(true).trimEnd() ?? "");
  };
  const run = async (args: string[]) => {
    if (args[0] === "display-message") {
      const a = oracle.buffer.active, n = oracle.buffer.normal;
      return { stdout: `${a.cursorX} ${a.cursorY} ${n.baseY} 24 ${a.type === "alternate" ? 1 : 0} ${n.cursorX} ${n.cursorY}`, stderr: "", code: 0 };
    }
    if (args[0] === "capture-pane") {
      if (args.includes("-a")) return { stdout: screen(oracle, true).join("\n").trimEnd(), stderr: "", code: 0 };
      if (args.includes("-S")) {
        const n = oracle.buffer.normal;
        return { stdout: Array.from({ length: n.baseY }, (_, y) => n.getLine(y)?.translateToString(true) ?? "").join("\n"), stderr: "", code: 0 };
      }
      if (forcing && ++captures <= 5) emit("\r\nLF");
      const captured = screen(oracle).join("\n").trimEnd();
      // The sampled LF is already in the grid, but its pipe byte remains in
      // flight when capture starts. 5ms redraws keep every settle busy.
      if (forcing) await Bun.sleep(12);
      return { stdout: captured, stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  b = new SessionBroadcaster(`exit-ws-${Date.now()}`, run, true);
  await b.start();
  const h = createWsHandlers({
    broadcasters: { get: async () => b }, getNativeAttachCount: async () => 1,
    pinViewport: async () => {}, tmux: async () => ({ stdout: "80|24", stderr: "", code: 0 }),
    sse: { emit() {} }, managedDb: { getScrollPos: () => null, setScrollPos() {} },
    input: { send: async () => undefined } as any,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as any,
  });
  const server = Bun.serve<WsData>({ hostname: "127.0.0.1", port: 0,
    fetch(req, s) { return s.upgrade(req, { data: { sessionName: b.session, cols: 80, rows: 24, connId: "overlap", unsubs: [], pin: true, resyncCapable: true } }) ? undefined : new Response("no", { status: 426 }); },
    websocket: h,
  });
  let timer: ReturnType<typeof setInterval> | undefined, parsed = Promise.resolve(), done = 0;
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`); ws.binaryType = "arraybuffer";
  ws.onmessage = event => {
    if (typeof event.data === "string") {
      const m = JSON.parse(event.data); if (m.kind === "scrollpos") parsed = parsed.then(() => { done++; });
    } else parsed = parsed.then(() => new Promise<void>(r => client.write(new Uint8Array(event.data as ArrayBuffer), r)));
  };
  try {
    await until(() => done > 0); expect(client.buffer.active.type).toBe("alternate");
    forcing = true; emit("\x1b[?1049l");
    timer = setInterval(() => { ticks++; emit("\x1b[1;1HTICK\x1b[24;1H"); }, 5);
    await until(() => captures >= 5 && done >= 2);
    await until(async () => { await parsed; return captures > 5 && JSON.stringify(screen(client)) === JSON.stringify(screen(oracle)); });
    expect(b.outputQuietFor(100)).toBe(false);
    const before = ticks; await Bun.sleep(25); expect(ticks).toBeGreaterThan(before);
    expect(client.buffer.active.type).toBe("normal");
  } finally {
    if (timer) clearInterval(timer); ws.close(); await until(() => h.connections() === 0);
    server.stop(true); await b.stop({ deleteLog: true }); oracle.dispose(); client.dispose(); rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
