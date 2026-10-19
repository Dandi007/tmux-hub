import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "tht-start-races-"));
process.env.TMUX_HUB_LOG_DIR = TMP;

import { BroadcasterRegistry, SessionBroadcaster } from "../../src/server/output-broadcaster";

afterAll(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

// #143: start() spans two tmux round trips. A fake runner holds the second
// pipe-pane (the one that opens the pipe) until the test releases it.
function gatedRunner(code = 0) {
  const calls: string[][] = [];
  let reach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((r) => { reach = r; });
  const released = new Promise<void>((r) => { release = r; });
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "pipe-pane" && !args.includes("-o")) {
      reach();
      await released;
      return { stdout: "", stderr: code ? "can't find pane" : "", code };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  return { run, calls, reached, release };
}

const live = (b: SessionBroadcaster) => {
  const x = b as unknown as { fd: number | null; pollTimer: unknown };
  return { fd: x.fd, timer: x.pollTimer };
};

test("concurrent get() waits for the same start and gets a started broadcaster", async () => {
  const g = gatedRunner();
  const reg = new BroadcasterRegistry(g.run as any, false);
  const first = reg.get("s1");
  await g.reached;
  // Observe the instance at the moment the second caller gets it.
  const second = reg.get("s1").then((b) => ({ b, fd: live(b).fd }));
  await Bun.sleep(10);
  g.release();
  const [a, got] = await Promise.all([first, second]);
  expect(got.b).toBe(a);
  expect(got.fd).not.toBeNull();
  await reg.stopAll();
});

test("concurrent get() both reject when start fails, and nothing is cached", async () => {
  const g = gatedRunner(1);
  const reg = new BroadcasterRegistry(g.run as any, false);
  const first = reg.get("s2");
  await g.reached;
  const second = reg.get("s2");
  g.release();
  const [r1, r2] = await Promise.allSettled([first, second]);
  expect(r1.status).toBe("rejected");
  expect(r2.status).toBe("rejected");
  expect(reg.size()).toBe(0);
});

test("stop() during start leaves no fd, poll timer or pipe behind", async () => {
  const g = gatedRunner();
  const b = new SessionBroadcaster("s3", g.run as any, false);
  const started = b.start();
  await g.reached;
  await b.stop();
  const closesBefore = g.calls.filter((c) => c[0] === "pipe-pane" && c.includes("-o")).length;
  g.release();
  await expect(started).rejects.toThrow(/stopped/);
  expect(live(b)).toEqual({ fd: null, timer: null });
  // The pipe tmux opened after stop()'s close is closed again.
  const closesAfter = g.calls.filter((c) => c[0] === "pipe-pane" && c.includes("-o")).length;
  expect(closesAfter).toBe(closesBefore + 1);
});

test("registry stop() during get() rejects the get and caches nothing", async () => {
  const g = gatedRunner();
  const reg = new BroadcasterRegistry(g.run as any, false);
  const got = reg.get("s4");
  await g.reached;
  await reg.stop("s4");
  g.release();
  await expect(got).rejects.toThrow(/stopped/);
  expect(reg.size()).toBe(0);
});

// Same-name recreate: main.ts fires the removed handler's stop() and the
// created handler's get() without awaiting either. The old stop's pipe close
// and log trash must land before the new start, or they hit the new pipe/log.
test("get() after a same-name stop() waits for that stop to finish", async () => {
  const seq: string[] = [];
  let releaseClose!: () => void;
  const closeGate = new Promise<void>((r) => { releaseClose = r; });
  let gated = false;
  const run = async (args: string[]) => {
    const kind = args[0] === "pipe-pane" ? (args.includes("-o") ? "close" : "open") : args[0]!;
    seq.push(kind);
    if (kind === "close" && gated) {
      gated = false;
      await closeGate;
      seq.push("close-done");
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  const reg = new BroadcasterRegistry(run as any, false);
  const old = await reg.get("s5");
  const logPath = old.logPath;
  seq.length = 0;

  gated = true;
  const stopping = reg.stop("s5", { deleteLog: true });
  const got = reg.get("s5");
  await Bun.sleep(20);
  releaseClose();
  await stopping;
  const fresh = await got;

  expect(fresh).not.toBe(old);
  // The new start's tmux calls all come after the old stop's close finished.
  expect(seq.slice(0, 2)).toEqual(["close", "close-done"]);
  expect(seq.slice(2)).toEqual(["close", "open"]);
  // The old stop trashed the old log, not the one the new pipe writes to.
  expect(existsSync(logPath)).toBe(true);
  await reg.stopAll();
});

// #147: back-to-back recreate. A second stop() (of the instance still waiting
// on the first stop) must not let the next get() skip the first stop.
test("get() after two same-name stops waits for the earlier stop too", async () => {
  const seq: string[] = [];
  let releaseClose!: () => void;
  const closeGate = new Promise<void>((r) => { releaseClose = r; });
  let gated = false;
  const run = async (args: string[]) => {
    const kind = args[0] === "pipe-pane" ? (args.includes("-o") ? "close" : "open") : args[0]!;
    seq.push(kind);
    if (kind === "close" && gated) {
      gated = false;
      await closeGate;
      seq.push("close-done");
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  const reg = new BroadcasterRegistry(run as any, false);
  await reg.get("s6");
  seq.length = 0;

  gated = true;
  const stop1 = reg.stop("s6", { deleteLog: true });
  const second = reg.get("s6"); // waits on stop1
  const stop2 = reg.stop("s6", { deleteLog: true });
  const third = reg.get("s6");
  await Bun.sleep(20);
  releaseClose();
  await Promise.all([stop1, stop2]);
  await expect(second).rejects.toThrow(/stopped/);
  await third;

  expect(seq.filter((k) => k === "open")).toHaveLength(1);
  expect(seq.indexOf("open")).toBeGreaterThan(seq.indexOf("close-done"));
  await reg.stopAll();
});

// #147: a read after the fd is open can throw (here EISDIR: the log path is a
// directory). start() must not leave the fd open or the pipe running.
test("start() that fails after opening the log closes the fd and the pipe", async () => {
  const calls: string[] = [];
  const run = async (args: string[]) => {
    calls.push(args[0] === "pipe-pane" ? (args.includes("-o") ? "close" : "open") : args[0]!);
    return { stdout: "", stderr: "", code: 0 };
  };
  const b = new SessionBroadcaster("s7-dir", run as any, false);
  mkdirSync(b.logPath, { recursive: true });
  const fds = () => readdirSync("/proc/self/fd").length;
  const before = fds();
  try {
    await expect(b.start()).rejects.toThrow();
    expect(live(b)).toEqual({ fd: null, timer: null });
    expect(fds()).toBe(before);
    expect(calls).toEqual(["close", "open", "close"]);
  } finally {
    rmSync(b.logPath, { recursive: true, force: true });
  }
});
