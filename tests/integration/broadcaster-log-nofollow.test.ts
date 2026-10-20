import { test, expect, afterAll } from "bun:test";
import { writeFileSync, appendFileSync, rmSync, symlinkSync, linkSync, existsSync, readdirSync, openSync, closeSync, writeSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionBroadcaster } from "../../src/server/output-broadcaster";

// In hub-sandbox the pane-log directory is writable by the (untrusted) agent,
// which can swap <session>.log for a link to a hub-private file. The hub must
// never read through such a link and stream the target to the session's viewers.

const cleanup: string[] = [];
afterAll(() => { for (const p of cleanup) try { rmSync(p, { force: true }); } catch {} });

const SECRET_TEXT = "TOP-SECRET-HUB-FILE\n";
function secretFile(): string {
  const p = join(tmpdir(), `rsi-nofollow-secret-${process.pid}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(p, SECRET_TEXT);
  cleanup.push(p);
  return p;
}

function recorder() {
  const calls: string[] = [];
  const run = async (args: string[]) => {
    calls.push(args.includes("-o") ? "close" : "open");
    return { stdout: "", stderr: "", code: 0 };
  };
  return { calls, run };
}

const fdCount = () => readdirSync("/proc/self/fd").length;

async function expectRejectedStart(session: string, plant: (log: string) => void) {
  const { calls, run } = recorder();
  const b = new SessionBroadcaster(session, run as any, false);
  cleanup.push(b.logPath);
  rmSync(b.logPath, { force: true });
  plant(b.logPath);
  const fds = fdCount();
  await expect(b.start()).rejects.toThrow();
  expect(fdCount()).toBe(fds);
  // The pipe opened during start is closed again.
  expect(calls.at(-1)).toBe("close");
  expect(calls.filter((c) => c === "open").length).toBeGreaterThan(0);
  return b;
}

test("start() refuses a log that is a symlink to another file", async () => {
  const target = secretFile();
  await expectRejectedStart("rsi-nofollow-sym", (log) => symlinkSync(target, log));
});

test("start() refuses a log that is a hard link to another file", async () => {
  const target = secretFile();
  await expectRejectedStart("rsi-nofollow-hard", (log) => linkSync(target, log));
});

test("start() does not create the target of a dangling symlink", async () => {
  const target = join(tmpdir(), `rsi-nofollow-dangling-${process.pid}`);
  cleanup.push(target);
  rmSync(target, { force: true });
  await expectRejectedStart("rsi-nofollow-dangle", (log) => symlinkSync(target, log));
  expect(existsSync(target)).toBe(false);
});

test("a log swapped for a symlink after start keeps streaming the original file", async () => {
  const { run } = recorder();
  const b = new SessionBroadcaster("rsi-nofollow-swap", run as any, false);
  cleanup.push(b.logPath);
  writeFileSync(b.logPath, "x".repeat(200));
  // Plays tmux's `cat >> log`: the sink keeps its own fd on the original inode.
  const sink = openSync(b.logPath, "a");
  await b.start();
  const got: string[] = [];
  const events: string[] = [];
  b.attach((c) => { got.push(new TextDecoder().decode(c)); });
  b.onEvent((e) => { events.push(e.kind); });

  unlinkSync(b.logPath);
  symlinkSync(secretFile(), b.logPath);
  writeSync(sink, "after-swap\n");
  await Bun.sleep(40);
  closeSync(sink);

  expect(events).toEqual([]);
  expect(got.join("")).toBe("after-swap\n");
  await b.stop();
});

test("a regular log still starts and streams", async () => {
  const { run } = recorder();
  const b = new SessionBroadcaster("rsi-nofollow-plain", run as any, false);
  cleanup.push(b.logPath);
  rmSync(b.logPath, { force: true });
  await b.start();
  const got: string[] = [];
  b.attach((c) => { got.push(new TextDecoder().decode(c)); });
  appendFileSync(b.logPath, "hi\n");
  await Bun.sleep(30);
  expect(got.join("")).toBe("hi\n");
  await b.stop();
});
