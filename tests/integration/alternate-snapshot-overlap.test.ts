import { test, expect } from "bun:test";
import { mkdtempSync, appendFileSync, rmSync } from "node:fs";

const dir = mkdtempSync("/tmp/alt-overlap-");
process.env.TMUX_HUB_LOG_DIR = dir;

// Controlled runner: a capture has already sampled alternate but its reply
// arrives after new application exit bytes reached the pipe log. Keep each
// attempt busy to exercise the existing bounded-overlap delivery path.
test("alternate snapshot consumer sees an exit parsed during alignment", async () => {
  const { SessionBroadcaster } = await import("../../src/server/output-broadcaster");
  let b: InstanceType<typeof SessionBroadcaster>, captures = 0;
  const run = async (args: string[]) => {
    if (args[0] === "display-message") return { stdout: "0 0 0 24 1 0 0", stderr: "", code: 0 };
    if (args[0] === "capture-pane") {
      if (args.includes("-a")) return { stdout: "saved", stderr: "", code: 0 };
      captures++;
      const before = b.bytesBroadcast();
      appendFileSync(b.logPath, "\x1b[?1049h\x1b[?1049l");
      const end = Date.now() + 1000;
      while (b.bytesBroadcast() === before && Date.now() < end) await Bun.sleep(5);
      expect(b.bytesBroadcast()).toBeGreaterThan(before);
      return { stdout: "ALT", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  b = new SessionBroadcaster(`alt-overlap-${Date.now()}`, run, true);
  try {
    await b.start();
    const delivered: unknown[] = [];
    await b.attachWithReplay(() => {}, 80, 24, undefined, snapshot => {
      delivered.push(snapshot);
    });
    expect(captures).toBe(5);
    expect(delivered).toEqual([{ alternate: true, normalExitPending: true, overlapped: true, authoritative: true }]);
  } finally { await b.stop({ deleteLog: true }); rmSync(dir, { recursive: true, force: true }); }
});
