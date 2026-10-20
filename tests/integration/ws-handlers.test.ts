import { test, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWsHandlers, type WsData, type WsDeps } from "../../src/server/ws-handlers";

// Isolate: private log dir so we never touch ~/.cache/tmux-hub.
process.env.TMUX_HUB_LOG_DIR = mkdtempSync(join(tmpdir(), "ws-handlers-"));

// Real WebSocket connections against the production handlers, with tmux and
// the broadcaster faked. Each case closes the client while open() (or a
// resize) is still awaiting, the way a flaky mobile network does.

type Gate = { reached: Promise<void>; release: () => void; wait: () => Promise<void> };
function gate(): Gate {
  let reach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((r) => { reach = r; });
  const released = new Promise<void>((r) => { release = r; });
  return { reached, release, wait: () => { reach(); return released; } };
}

type Fake = ReturnType<typeof fakeBroadcaster>;
function fakeBroadcaster(attach: () => Promise<() => void> = async () => () => {}) {
  const listeners = new Set<unknown>();
  return {
    listeners,
    ring: { truncated: () => false },
    onEvent(fn: unknown) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    attachWithReplay: () => attach(),
    resync: async () => {},
    syncEmulatorSize() {},
  };
}

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };
const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterEach(() => { for (const s of servers.splice(0)) s.stop(true); });

function start(over: Partial<WsDeps> & { broadcaster?: Fake | unknown } = {}) {
  const calls = { pin: 0, get: 0 };
  const b = over.broadcaster ?? fakeBroadcaster();
  const deps: WsDeps = {
    broadcasters: { get: async () => { calls.get++; return b as any; } },
    getNativeAttachCount: async () => 0,
    pinViewport: async () => { calls.pin++; },
    tmux: async () => ({ stdout: "80|24", stderr: "", code: 0 }),
    sse: { emit() {} },
    managedDb: { getScrollPos: () => null, setScrollPos() {} },
    input: { send: async () => undefined } as any,
    logger: noopLogger as any,
    ...over,
  };
  const h = createWsHandlers(deps);
  let n = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const u = new URL(req.url);
      const data: WsData = {
        sessionName: "s", cols: Number(u.searchParams.get("cols") ?? 80), rows: 24,
        connId: `c${++n}`, unsubs: [], resyncCapable: false, pin: true,
      };
      return srv.upgrade(req, { data }) ? undefined : new Response("no", { status: 426 });
    },
    websocket: h,
  });
  servers.push(server);
  return { h, calls, url: (q = "") => `ws://127.0.0.1:${server.port}/?${q}` };
}

// A client that records the JSON control messages it receives.
async function connect(url: string, waitAttached = true) {
  const ws = new WebSocket(url);
  const msgs: any[] = [];
  let onScrollpos!: () => void;
  const attached = new Promise<void>((r) => { onScrollpos = r; });
  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") return;
    try { const m = JSON.parse(ev.data); msgs.push(m); if (m.kind === "scrollpos") onScrollpos(); } catch {}
  };
  await new Promise<void>((r, j) => { ws.onopen = () => r(); ws.onerror = () => j(new Error("ws error")); });
  if (waitAttached) await attached;
  return { ws, msgs };
}

async function until(cond: () => boolean, ms = 2000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await Bun.sleep(5);
  }
}
const settle = () => Bun.sleep(30);
const viewports = (msgs: any[]) => msgs.filter((m) => m.kind === "viewport");

test("closed while checking native clients: no pin, no attach", async () => {
  const g = gate();
  const { h, calls, url } = start({ getNativeAttachCount: async () => { await g.wait(); return 0; } });
  const { ws } = await connect(url(), false);
  await g.reached;
  ws.close();
  await until(() => h.connections() === 0);
  g.release();
  await settle();
  expect(calls.pin).toBe(0);
  expect(calls.get).toBe(0);
});

test("closed while pinning: other pages reclaim instead of adopting a dead size", async () => {
  let g: Gate | null = null;
  const { h, url } = start({ pinViewport: async () => { if (g) await g.wait(); } });
  const a = await connect(url("cols=120"));
  g = gate();
  const { ws: bws } = await connect(url("cols=60"), false);
  await g.reached;
  bws.close();
  await until(() => h.connections() === 1);
  g.release();
  await settle();
  const last = viewports(a.msgs).at(-1);
  expect(last?.peer).toBeUndefined();
  expect(last?.released).toBe(true);
  // A later close by A finds nothing left pinned to B.
  a.ws.close();
  await until(() => h.connections() === 0);
  expect(h.peers.size()).toBe(0);
});

test("closed while a resize is in flight: other pages reclaim", async () => {
  const g = gate();
  const { h, url } = start({
    input: { send: async () => { await g.wait(); return { cols: 50, rows: 20 }; } } as any,
  });
  const a = await connect(url("cols=120"));
  const b = await connect(url("cols=90"));
  b.ws.send(JSON.stringify({ kind: "resize", cols: 50, rows: 20 }));
  await g.reached;
  b.ws.close();
  await until(() => h.connections() === 1);
  g.release();
  await settle();
  const last = viewports(a.msgs).at(-1);
  expect(last?.peer).toBeUndefined();
  expect(last?.released).toBe(true);
});

test("closed during attach leaves no subscriber behind (real broadcaster)", async () => {
  const { SessionBroadcaster } = await import("../../src/server/output-broadcaster");
  const g = gate();
  const run = async (args: string[]) => {
    if (args[0] === "display-message") return { stdout: "0 0 0 24 0 0 0", stderr: "", code: 0 };
    if (args[0] === "capture-pane") { await g.wait(); return { stdout: "SNAPSHOT", stderr: "", code: 0 }; }
    return { stdout: "", stderr: "", code: 0 };
  };
  const b = new SessionBroadcaster("ws-handlers-1", run as any, true);
  await b.start();
  const { h, url } = start({ broadcaster: b });
  const { ws } = await connect(url(), false);
  await g.reached;
  ws.close();
  await until(() => h.connections() === 0);
  g.release();
  // The aligned snapshot takes a settle window or more to finish.
  await until(() => b.subscriberCount() === 0);
  await Bun.sleep(150);
  expect(b.subscriberCount()).toBe(0);
  await b.stop({ deleteLog: true });
});

test("attach failure drops the event listener and closes the ws", async () => {
  const b = fakeBroadcaster(async () => { throw new Error("capture failed"); });
  const { h, url } = start({ broadcaster: b });
  const ws = new WebSocket(url());
  const closed = new Promise<number>((r) => { ws.onclose = (ev) => r(ev.code); });
  expect(await closed).toBe(1011);
  await until(() => h.connections() === 0);
  expect(b.listeners.size).toBe(0);
});
