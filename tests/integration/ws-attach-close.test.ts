import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptUnsubs } from "../../src/server/ws-attach";

// Isolate: private log dir so we never touch ~/.cache/tmux-hub.
process.env.TMUX_HUB_LOG_DIR = mkdtempSync(join(tmpdir(), "ws-attach-close-"));

// The ws closes while open() is still awaiting the attach snapshot (flaky
// mobile network). close() has already drained `unsubs`, so the subscriber the
// attach registered must be removed when open() resumes — not leaked.
test("a ws closed during attach leaves no subscriber behind", async () => {
  const { SessionBroadcaster } = await import("../../src/server/output-broadcaster");
  let releaseCapture!: () => void;
  const captureGate = new Promise<void>((r) => { releaseCapture = r; });
  const run = async (args: string[]) => {
    if (args[0] === "capture-pane") {
      await captureGate;
      return { stdout: "SNAPSHOT", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  const b = new SessionBroadcaster("ws-close-1", run as any, true);
  await b.start();

  const data: { closed?: boolean; unsubs: Array<() => void> } = { unsubs: [] };
  const unsubEvents = b.onEvent(() => {});
  const attached = b.attachWithReplay(() => {}, 80, 24);

  // close() runs mid-attach: marks closed and drains the (still empty) unsubs.
  data.closed = true;
  for (const fn of data.unsubs) fn();
  data.unsubs.length = 0;

  releaseCapture();
  const unsubData = await attached;
  expect(adoptUnsubs(data, unsubEvents, unsubData)).toBe(false);
  expect(b.subscriberCount()).toBe(0);
  expect(data.unsubs).toHaveLength(0);

  await b.stop({ deleteLog: true });
});

test("an open ws keeps its unsubs for close()", async () => {
  const data: { closed?: boolean; unsubs: Array<() => void> } = { unsubs: [] };
  let called = 0;
  expect(adoptUnsubs(data, () => called++, () => called++)).toBe(true);
  expect(called).toBe(0);
  expect(data.unsubs).toHaveLength(2);
});
