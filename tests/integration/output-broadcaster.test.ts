import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set TMUX_HUB_LOG_DIR before importing the broadcaster module (the LOG_DIR
// constant is captured at import time).
const TEST_LOG_DIR = mkdtempSync(join(tmpdir(), "tht-bcast-"));
process.env.TMUX_HUB_LOG_DIR = TEST_LOG_DIR;

import { tmuxTest, tmuxTestKillServer } from "../helpers/tmux-test";
import { SessionBroadcaster } from "../../src/server/output-broadcaster";

const S = "user-bcast-" + Date.now().toString().slice(-8);

beforeAll(async () => {
  await tmuxTest([
    "new-session", "-d", "-s", S,
    "sh", "-c", "i=0; while true; do echo tick-$i; i=$((i+1)); sleep 0.05; done",
  ]);
});

afterAll(async () => {
  await tmuxTest(["kill-session", "-t", S]).catch(() => undefined);
  await tmuxTestKillServer();
  try { rmSync(TEST_LOG_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("output-broadcaster (S1b)", () => {
  test("captures session output and fans out to subscribers", async () => {
    const b = new SessionBroadcaster(S, tmuxTest);
    await b.start();

    const sub1: Uint8Array[] = [];
    const sub2: Uint8Array[] = [];
    b.attach((c) => { sub1.push(c); });
    b.attach((c) => { sub2.push(c); });

    await new Promise((r) => setTimeout(r, 600));

    const total1 = sub1.reduce((acc, c) => acc + c.length, 0);
    const total2 = sub2.reduce((acc, c) => acc + c.length, 0);
    expect(total1).toBeGreaterThan(0);
    expect(total1).toBe(total2);

    const text1 = Buffer.concat(sub1.map((c) => Buffer.from(c))).toString("utf8");
    expect(text1).toContain("tick");
    expect(existsSync(b.logPath)).toBe(true);

    await b.stop();
    expect(existsSync(b.logPath)).toBe(false);
  }, 8000);

  test("sendInitialSnapshot emits terminal reset then visible capture", async () => {
    const b = new SessionBroadcaster(S, tmuxTest);
    await b.start();
    await new Promise((r) => setTimeout(r, 400));

    const chunks: Uint8Array[] = [];
    await b.sendInitialSnapshot((c) => chunks.push(c));

    expect(chunks[0]).toBeDefined();
    const firstText = Buffer.from(chunks[0]!).toString("utf8");
    expect(firstText.startsWith("\x1bc")).toBe(true);

    const allText = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    expect(allText).toContain("tick");

    await b.stop();
  }, 5000);

  test("stop is idempotent and cleans up", async () => {
    const b = new SessionBroadcaster(S, tmuxTest);
    await b.start();
    await b.stop();
    await b.stop(); // should not throw
    expect(b.subscriberCount()).toBe(0);
    expect(existsSync(b.logPath)).toBe(false);
  }, 5000);
});
