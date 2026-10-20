import { test, expect } from "bun:test";
import { ResyncScheduler } from "../../src/server/resize-resync";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A web resize reflows the browser's xterm and tmux independently; the two
// reflows disagree on soft-wrapped lines, and the app's SIGWINCH redraw then
// lands on different rows (fidelity oracle: extra zsh PROMPT_SP row, never
// heals). The scheduler decides WHEN to re-send an aligned snapshot.

test("a burst of resizes collapses into one resync at the final size", async () => {
  const calls: string[] = [];
  const s = new ResyncScheduler(200, 50, Promise.resolve(), async (c, r) => { calls.push(`${c}x${r}`); }, 20);
  s.resized(180, 50);
  s.resized(150, 45);
  s.resized(120, 40);
  await tick(60);
  expect(calls).toEqual(["120x40"]);
});

test("a resize back to the snapshot's size does not resync", async () => {
  const calls: string[] = [];
  const s = new ResyncScheduler(200, 50, Promise.resolve(), async (c, r) => { calls.push(`${c}x${r}`); }, 20);
  s.resized(200, 50);
  await tick(60);
  expect(calls).toEqual([]);
  s.resized(100, 30);
  await tick(60);
  s.resized(100, 30);
  await tick(60);
  expect(calls).toEqual(["100x30"]);
});

test("resyncs wait for the initial attach and never overlap", async () => {
  const log: string[] = [];
  let finishAttach!: () => void;
  const attach = new Promise<void>((r) => { finishAttach = r; });
  const s = new ResyncScheduler(200, 50, attach, async (c) => {
    log.push(`start ${c}`);
    await tick(40);
    log.push(`end ${c}`);
  }, 10);
  s.resized(100, 30);
  await tick(40);
  expect(log).toEqual([]); // attach still running
  finishAttach();
  await tick(5);
  s.resized(90, 30); // lands while the first resync is in flight
  await tick(150);
  expect(log).toEqual(["start 100", "end 100", "start 90", "end 90"]);
});

test("dispose cancels a pending resync", async () => {
  const calls: string[] = [];
  const s = new ResyncScheduler(200, 50, Promise.resolve(), async (c, r) => { calls.push(`${c}x${r}`); }, 20);
  s.resized(100, 30);
  s.dispose();
  await tick(60);
  expect(calls).toEqual([]);
});

test("a failing resync does not wedge later ones", async () => {
  const calls: string[] = [];
  let n = 0;
  const s = new ResyncScheduler(200, 50, Promise.resolve(), async (c) => {
    calls.push(String(c));
    if (n++ === 0) throw new Error("boom");
  }, 10);
  s.resized(100, 30);
  await tick(40);
  s.resized(90, 30);
  await tick(40);
  expect(calls).toEqual(["100", "90"]);
});

// The pane may go away and come back within one debounce window (a hidden
// pool slot activating fits to another size and back). The app redrew at the
// intermediate size and the client reflowed twice, so the screens can still
// disagree even though the final size equals the snapshot's.
test("a resize away and back within one window still resyncs", async () => {
  const calls: string[] = [];
  const s = new ResyncScheduler(200, 50, Promise.resolve(), async (c, r) => { calls.push(`${c}x${r}`); }, 20);
  s.resized(150, 40);
  s.resized(200, 50);
  await tick(60);
  expect(calls).toEqual(["200x50"]);
});

test("overlap repair waits for quiet and initial attach, then uses current dimensions", async () => {
  const calls: string[] = [];
  let quiet = false;
  let ready!: () => void;
  const s = new ResyncScheduler(200, 50, new Promise<void>(r => { ready = r; }), async (c, r) => {
    calls.push(`${c}x${r}`);
  }, 10);
  s.repairWhenQuiet(() => quiet);
  await tick(130);
  expect(calls).toEqual([]);
  quiet = true;
  await tick(130);
  expect(calls).toEqual([]);
  s.resized(120, 40);
  ready();
  await tick(160);
  expect(calls).toEqual(["120x40"]);
  s.dispose();
});

test("busy output defers repair captures; another overlap rearms recovery", async () => {
  let quiet = false;
  let calls = 0;
  const s = new ResyncScheduler(80, 24, Promise.resolve(), async () => {
    calls++;
    if (calls === 1) s.repairWhenQuiet(() => quiet);
  }, 10);
  s.repairWhenQuiet(() => quiet);
  await tick(230);
  expect(calls).toBe(0);
  quiet = true;
  await tick(250);
  expect(calls).toBe(2);
  s.dispose();
});

test("dispose cancels queued overlap recovery before initial attach finishes", async () => {
  let ready!: () => void;
  let calls = 0;
  const s = new ResyncScheduler(80, 24, new Promise<void>(r => { ready = r; }), async () => { calls++; }, 10);
  s.repairWhenQuiet(() => true);
  await tick(130);
  s.dispose();
  ready();
  await tick(150);
  expect(calls).toBe(0);
});

test("overlap repair stays behind an in-flight resize snapshot", async () => {
  let release!: () => void;
  let active = 0, maxActive = 0, calls = 0;
  const s = new ResyncScheduler(80, 24, Promise.resolve(), async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    calls++;
    if (calls === 1) await new Promise<void>(r => { release = r; });
    active--;
  }, 10);
  s.resized(100, 30);
  await tick(40);
  s.repairWhenQuiet(() => true);
  await tick(130);
  expect(calls).toBe(1);
  release();
  await tick(130);
  expect(calls).toBe(2);
  expect(maxActive).toBe(1);
  s.dispose();
});


test("urgent normal-screen repair cannot be postponed by continuously busy overlap", async () => {
  let calls = 0, ready!: () => void;
  const s = new ResyncScheduler(80, 24, new Promise<void>(r => { ready = r; }), async () => { calls++; });
  s.repairNow(); s.repairWhenQuiet(() => false);
  await tick(130); expect(calls).toBe(0);
  ready(); await tick(160); expect(calls).toBe(1);
  s.dispose();
});

test("dispose cancels an urgent repair", async () => {
  let calls = 0;
  const s = new ResyncScheduler(80, 24, Promise.resolve(), async () => { calls++; });
  s.repairNow(); s.dispose(); await tick(160); expect(calls).toBe(0);
});
