import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WsData } from "../../src/server/ws-handlers";

const dir = mkdtempSync(join(tmpdir(), "ws-busy-recovery-"));
process.env.TMUX_HUB_LOG_DIR = dir;
const { SessionBroadcaster, snapshotStats } = await import("../../src/server/output-broadcaster");
const { createWsHandlers } = await import("../../src/server/ws-handlers");
const until = async (check: () => boolean) => {
  for (let i = 0; i < 400; i++) { if (check()) return; await Bun.sleep(5); }
  throw Error("busy recovery boundary did not complete");
};

test("real WS busy attach exhausts all five captures then repairs on the same connection", async () => {
  let busy = false, captures = 0, accepted = 0;
  const run = async (args: string[]) => {
    if (args[0] === "display-message") return { stdout: "0 0 0 24 0 0 0", stderr: "", code: 0 };
    if (args[0] === "capture-pane") {
      captures++;
      if (busy) {
        const before = broadcaster.bytesBroadcast();
        appendFileSync(broadcaster.logPath, `BUSY_${captures}\r\n`);
        // Observe real log->poll consumption WHILE the snapshot tap is live.
        // This guarantees pending bytes in every capture, independent of OS timing.
        await until(() => broadcaster.bytesBroadcast() > before);
      }
      return { stdout: busy ? "BUSY_SCREEN" : "QUIET_SCREEN", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  const broadcaster = new SessionBroadcaster(`ws-busy-${process.pid}`, run, true);
  await broadcaster.start();
  const handlers = createWsHandlers({
    broadcasters: { get: async () => broadcaster }, getNativeAttachCount: async () => 0,
    pinViewport: async () => {}, tmux: async () => ({ stdout: "80|24", stderr: "", code: 0 }),
    sse: { emit() {} }, managedDb: { getScrollPos: () => 30, setScrollPos() {} },
    input: { send: async () => undefined }, logger: { info() {}, debug() {}, warn() {}, error() {} } as any,
  });
  const clients: WebSocket[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(req, srv) {
      const data: WsData = { sessionName: "busy", cols: 80, rows: 24, connId: `c${++accepted}`, unsubs: [], resyncCapable: true, pin: true };
      return srv.upgrade(req, { data }) ? undefined : new Response("upgrade", { status: 426 });
    }, websocket: handlers,
  });
  const connect = async () => {
    const frames: string[] = [], meta: any[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`); clients.push(ws);
    ws.binaryType = "arraybuffer";
    ws.onmessage = e => {
      if (typeof e.data === "string") { try { meta.push(JSON.parse(e.data)); } catch {} }
      else frames.push(new TextDecoder().decode(e.data));
    };
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(Error("WS failed")); });
    await until(() => meta.some(m => m.kind === "scrollpos"));
    return { ws, frames, meta };
  };
  try {
    const first = await connect(); first.ws.close(); await until(() => handlers.connections() === 0);
    const before = { ...snapshotStats }, baseCaptures = captures;
    busy = true;
    const current = await connect();
    expect(captures - baseCaptures).toBe(5);
    expect(snapshotStats.snapshots - before.snapshots).toBe(1);
    expect(snapshotStats.retries - before.retries).toBe(4);
    expect(snapshotStats.overlaps - before.overlaps).toBe(1);
    expect(current.frames.join("")).toContain("BUSY_SCREEN");
    expect(current.meta.filter(m => m.kind === "scrollpos").map(m => m.linesFromBottom)).toEqual([30]);
    busy = false;
    await until(() => current.meta.some(m => m.kind === "resync") && current.meta.filter(m => m.kind === "scrollpos").length === 2);
    expect(current.frames.join("")).toContain("QUIET_SCREEN");
    expect(captures - baseCaptures).toBe(6);
    expect(current.meta.filter(m => m.kind === "scrollpos").map(m => m.linesFromBottom)).toEqual([30, 30]);
    expect(snapshotStats.overlaps - before.overlaps).toBe(1);
    expect(accepted).toBe(2); expect(handlers.connections()).toBe(1); // No third upgrade for repair.
  } finally {
    for (const c of clients) c.close();
    await until(() => handlers.connections() === 0); server.stop(true);
    await broadcaster.stop({ deleteLog: true }); rmSync(dir, { recursive: true, force: true });
  }
});
