import { test, expect } from "bun:test";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TMUX_HUB_LOG_DIR = mkdtempSync(join(tmpdir(), "overlap-test-"));
const { SessionBroadcaster } = await import("../../src/server/output-broadcaster");

test("bounded busy snapshot reports overlap and exposes later output quiet", async () => {
  let captures = 0, overlaps = 0;
  let busy = true;
  const run = async (args: string[]) => {
    if (args[0] === "capture-pane") {
      captures++;
      if (busy) appendFileSync(b.logPath, "delta\r\n");
      return { stdout: "screen", stderr: "", code: 0 };
    }
    return { stdout: args[0] === "display-message" ? "0 0 0 24" : "", stderr: "", code: 0 };
  };
  const b = new SessionBroadcaster(`overlap-${process.pid}`, run, true);
  await b.start();
  try {
    const send = () => {};
    const unsubscribe = await b.attachWithReplay(send, 80, 24, () => { overlaps++; });
    expect(captures).toBe(5);
    expect(overlaps).toBe(1);
    expect(b.outputQuietFor(100)).toBe(false);
    await Bun.sleep(120);
    expect(b.outputQuietFor(100)).toBe(true);
    busy = false;
    await b.resync(send, 80, 24, () => {}, () => { overlaps++; });
    expect(overlaps).toBe(1);
    expect(captures).toBe(6);
    unsubscribe();
    expect(b.subscriberCount()).toBe(0);
  } finally { await b.stop({ deleteLog: true }); }
});
