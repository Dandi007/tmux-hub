import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WsData } from "../../src/server/ws-handlers";
import { handleViewportMessage } from "../../src/web/viewport-owner";

process.env.TMUX_HUB_LOG_DIR = mkdtempSync(join(tmpdir(), "ws-viewport-"));
const { createWsHandlers } = await import("../../src/server/ws-handlers");

function gate() {
  let reach!: () => void, release!: () => void;
  const reached = new Promise<void>((r) => { reach = r; });
  const done = new Promise<void>((r) => { release = r; });
  return { reached, release, wait: () => { reach(); return done; } };
}
async function until(f: () => boolean) {
  for (let i = 0; i < 400; i++) { if (f()) return; await Bun.sleep(5); }
  throw new Error("viewport did not settle");
}
const cleanups: Array<() => Promise<void>> = [];
type Client = { cols: number; attached: boolean; messages: any[]; ws: WebSocket };
afterEach(async () => { for (const fn of cleanups.splice(0)) await fn(); });

// Real WS + production handlers/reducer. Only the tmux and snapshot boundary
// timings are controlled; assertions concern the final pane and client grids.
function start(opts: {
  send?: (session: string, msg: any) => Promise<any>;
  pin?: (cols: number) => Promise<void>;
  attach?: (cols: number) => Promise<void>;
  get?: () => Promise<void>;
} = {}) {
  let pane = 80;
  const applied: number[] = [], snapshots: number[] = [], resyncs: number[] = [];
  const clients: Client[] = [];
  const listeners = new Set<unknown>();
  const broadcaster = {
    onEvent(fn: unknown) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    async attachWithReplay(_send: unknown, cols: number) {
      snapshots.push(cols); await opts.attach?.(cols); return () => {};
    },
    async resync(_send: unknown, cols: number) { resyncs.push(cols); },
    syncEmulatorSize() {},
  };
  const h = createWsHandlers({
    broadcasters: { get: async () => { await opts.get?.(); return broadcaster as any; } },
    getNativeAttachCount: async () => 0,
    pinViewport: async (_name, cols) => { pane = cols; await opts.pin?.(cols); },
    tmux: async () => ({ stdout: `${pane}|24`, stderr: "", code: 0 }),
    sse: { emit() {} }, managedDb: { getScrollPos: () => null, setScrollPos() {} },
    input: { send: async (name: string, msg: any) => {
      if (msg.kind === "resize") { applied.push(msg.cols); pane = msg.cols; }
      return opts.send ? opts.send(name, msg) : { cols: msg.cols, rows: msg.rows };
    } } as any,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as any,
  });
  let id = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req, srv) {
      const u = new URL(req.url);
      const data: WsData = {
        sessionName: u.searchParams.get("session") ?? "s", cols: Number(u.searchParams.get("cols")), rows: 24,
        connId: `c${++id}`, unsubs: [], resyncCapable: true, pin: true,
      };
      return srv.upgrade(req, { data }) ? undefined : new Response("no", { status: 426 });
    }, websocket: h,
  });
  async function connect(cols: number, attached = true, session = "s"): Promise<Client> {
    const c = { cols, attached: false, messages: [] as any[], ws: new WebSocket(`ws://127.0.0.1:${server.port}/?cols=${cols}&session=${session}`) };
    c.ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      const m = JSON.parse(ev.data); c.messages.push(m);
      if (m.kind === "scrollpos") c.attached = true;
      if (m.kind === "viewport") {
        const { action } = handleViewportMessage(m, { owner: "web", cols: c.cols, rows: 24 });
        if (action.type === "resize") c.cols = action.cols;
      }
    };
    clients.push(c);
    await new Promise<void>((r, j) => { c.ws.onopen = () => r(); c.ws.onerror = () => j(new Error("WS error")); });
    if (attached) await until(() => c.attached);
    return c;
  }
  const resize = (c: Client, cols: number) => {
    c.cols = cols; c.ws.send(JSON.stringify({ kind: "resize", cols, rows: 24 }));
  };
  cleanups.push(async () => {
    for (const c of clients) c.ws.close();
    await until(() => h.connections() === 0); server.stop(true);
    expect(listeners.size).toBe(0); expect(h.peers.size()).toBe(0);
  });
  return { connect, resize, applied, snapshots, resyncs, pane: () => pane, connections: h.connections };
}

test("concurrent resizes publish in applied order and both pages adopt the final size", async () => {
  const g = gate();
  const hub = start({ send: async (_n, m) => { if (m.cols === 164) await g.wait(); return { cols: m.cols, rows: m.rows }; } });
  const a = await hub.connect(120), b = await hub.connect(183);
  hub.resize(a, 164); await g.reached; hub.resize(b, 183);
  try {
    await Bun.sleep(40);
    expect(hub.applied).toEqual([164]); // B must not execute ahead of A's publication.
  } finally { g.release(); }
  await until(() => hub.applied.length === 2);
  await until(() => a.cols === 183 && b.cols === 183);
  expect(hub.pane()).toBe(183);
});

test("initial pin and later resize share the same applied order", async () => {
  const g = gate();
  const hub = start({ pin: async (cols) => { if (cols === 90) await g.wait(); } });
  const a = await hub.connect(120), b = await hub.connect(90, false);
  await g.reached; hub.resize(a, 120);
  try { await Bun.sleep(40); expect(hub.applied).toEqual([]); } finally { g.release(); }
  await until(() => b.attached && hub.applied.length === 1);
  await until(() => a.cols === 120 && b.cols === 120);
  expect(hub.pane()).toBe(120);
});

test("a page still attaching receives a newer pin and resyncs after its initial snapshot", async () => {
  const g = gate();
  const hub = start({ attach: async (cols) => { if (cols === 90) await g.wait(); } });
  const a = await hub.connect(120), b = await hub.connect(90, false);
  await g.reached; hub.resize(a, 120);
  try {
    await until(() => hub.applied.length === 1);
    await Bun.sleep(40);
  } finally { g.release(); }
  await until(() => b.attached && b.cols === 120);
  await until(() => hub.resyncs.filter(c => c === 120).length === 2);
  expect(hub.pane()).toBe(120);
});

test("a page awaiting its broadcaster snapshots the latest applied size", async () => {
  const g = gate(); let gets = 0;
  const hub = start({ get: async () => { if (++gets === 2) await g.wait(); } });
  const a = await hub.connect(120), b = await hub.connect(90, false);
  await g.reached; hub.resize(a, 120);
  try { await until(() => hub.applied.length === 1); await Bun.sleep(30); } finally { g.release(); }
  await until(() => b.attached);
  expect(hub.snapshots).toEqual([120, 120]);
  expect(b.cols).toBe(120);
});

test("a failed resize does not block the next viewport update", async () => {
  const hub = start({ send: async (_n, m) => { if (m.cols === 90) throw new Error("resize rejected"); return { cols: m.cols, rows: m.rows }; } });
  const a = await hub.connect(120), b = await hub.connect(183);
  hub.resize(a, 90); hub.resize(b, 150);
  await until(() => a.messages.some(m => m.error));
  await until(() => a.cols === 150 && b.cols === 150);
  expect(hub.pane()).toBe(150);
});

test("queued resize is discarded if its connection closes before execution", async () => {
  const g = gate();
  const hub = start({ send: async (_n, m) => { if (m.cols === 90) await g.wait(); return { cols: m.cols, rows: m.rows }; } });
  const a = await hub.connect(120), b = await hub.connect(183);
  hub.resize(a, 90); await g.reached; hub.resize(b, 150);
  b.ws.close(); await until(() => hub.connections() === 1);
  g.release(); await Bun.sleep(80);
  expect(hub.applied).toEqual([90]);
  expect(hub.pane()).toBe(90);
});

test("a viewport wait does not block keys or another session's pin", async () => {
  const g = gate(); let key = false;
  const hub = start({ send: async (_n, m) => { if (m.kind === "resize") await g.wait(); else key = true; return { cols: m.cols, rows: m.rows }; } });
  const a = await hub.connect(120);
  hub.resize(a, 90); await g.reached;
  try {
    a.ws.send(JSON.stringify({ kind: "key", name: "Enter" }));
    await until(() => key);
    const other = await hub.connect(100, false, "other");
    await until(() => other.attached);
  } finally { g.release(); }
});
