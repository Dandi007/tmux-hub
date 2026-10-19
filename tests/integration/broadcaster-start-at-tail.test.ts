import { test, expect, afterAll } from "bun:test";
import { writeFileSync, appendFileSync, rmSync } from "node:fs";

import { SessionBroadcaster } from "../../src/server/output-broadcaster";

const logs: string[] = [];
afterAll(() => { for (const l of logs) try { rmSync(l, { force: true }); } catch {} });

// The pipe itself is faked; the test plays tmux by appending to the log.
const okRunner = async () => ({ stdout: "", stderr: "", code: 0 });
const dec = new TextDecoder();

async function started(session: string, history: string | Uint8Array) {
  const b = new SessionBroadcaster(session, okRunner as any, false);
  const log = b.logPath;
  logs.push(log);
  writeFileSync(log, history);
  await b.start();
  const got: string[] = [];
  b.attach((c) => { got.push(dec.decode(c)); });
  await Bun.sleep(30); // several 5ms poll ticks
  return { b, got, log };
}

test("start() does not re-read the existing log; only new bytes are broadcast", async () => {
  const history = new Uint8Array(4 * 1024 * 1024).fill(0x61); // 4MB of 'a'
  const { b, got, log } = await started("rsi-tail-big", history);
  expect(b.bytesBroadcast()).toBe(0);
  expect(got.join("")).toBe("");
  appendFileSync(log, "NEW\n");
  await Bun.sleep(30);
  expect(got.join("")).toBe("NEW\n");
  await b.stop();
});

test("a small existing log is not re-broadcast either", async () => {
  const { b } = await started("rsi-tail-small", "hello\n");
  expect(b.bytesBroadcast()).toBe(0);
  await b.stop();
});

test("a window-name sequence split at the log end is still stripped", async () => {
  const { b, got, log } = await started("rsi-tail-split", "prompt$ \x1bkpri");
  appendFileSync(log, "ntf\x1b\\hello\n");
  await Bun.sleep(30);
  expect(got.join("")).toBe("hello\n");
  await b.stop();
});

test("a log truncated under the broadcaster fires replay_truncated and resumes at the new end", async () => {
  const { b, got, log } = await started("rsi-tail-shrink", "x".repeat(100));
  const events: string[] = [];
  b.onEvent((e) => { events.push(e.kind); });
  writeFileSync(log, "");
  await Bun.sleep(30);
  expect(events).toEqual(["replay_truncated"]);
  appendFileSync(log, "after\n");
  await Bun.sleep(30);
  expect(got.join("")).toBe("after\n");
  await b.stop();
});
