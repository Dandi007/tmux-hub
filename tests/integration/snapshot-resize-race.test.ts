import { test, expect } from "bun:test";
import { mkdtempSync, appendFileSync, rmSync } from "node:fs";
import { Terminal } from "@xterm/headless";

const dir = mkdtempSync("/tmp/snapshot-resize-race-");
process.env.TMUX_HUB_LOG_DIR = dir;

test("old capture retry preserves newer shared emulator size and observed margins", async () => {
  const { SessionBroadcaster } = await import("../../src/server/output-broadcaster");
  let b: InstanceType<typeof SessionBroadcaster>, captures = 0, rows = 24;
  const run = async (args: string[]) => {
    if (args[0] === "display-message") return { stdout: `0 2 0 ${rows} 0 0 0`, stderr: "", code: 0 };
    if (args[0] === "capture-pane") {
      if (++captures === 1) {
        // A has sampled its old geometry. B applies a newer pane size and the
        // app establishes margins before A's in-flight capture completes.
        rows = 30; b.syncEmulatorSize(80, rows);
        const before = b.bytesBroadcast();
        appendFileSync(b.logPath, "\x1b[3;25r\x1b[?6h");
        const end = Date.now() + 1000;
        while (b.bytesBroadcast() === before && Date.now() < end) await Bun.sleep(5);
        expect(b.bytesBroadcast()).toBeGreaterThan(before);
      }
      return { stdout: "", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  b = new SessionBroadcaster(`resize-race-${Date.now()}`, run, true);
  const chunks: Uint8Array[] = [], restored = new Terminal({ cols: 80, rows: 30, allowProposedApi: true });
  try {
    await b.start();
    await b.attachWithReplay(c => chunks.push(c), 80, 24);
    expect(captures).toBeGreaterThan(1);
    const data = Buffer.concat(chunks).toString();
    expect(data).toContain("\x1b[3;25r");
    await new Promise<void>(r => restored.write(data + "\x1b[2;1HX", r));
    expect(restored.buffer.active.getLine(3)?.translateToString(true)).toBe("X");
  } finally { restored.dispose(); await b.stop({ deleteLog: true }); rmSync(dir, { recursive: true, force: true }); }
});
