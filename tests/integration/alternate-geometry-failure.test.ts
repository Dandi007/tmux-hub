import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, appendFileSync, rmSync } from "node:fs";
import { Terminal } from "@xterm/headless";
const dir = mkdtempSync("/tmp/alt-geometry-");
process.env.TMUX_HUB_LOG_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));
for (const geometry of ["error", "", "0 0 0 24"]) {
  test(`unknown pane mode uses coherent fallback instead of normal capture: ${geometry || "empty"}`, async () => {
    const { SessionBroadcaster } = await import("../../src/server/output-broadcaster");
    let visibleCaptures = 0;
    const run = async (args: string[]) => {
      if (args[0] === "display-message") return { stdout: geometry, stderr: "", code: geometry === "error" ? 1 : 0 };
      if (args[0] === "capture-pane") { visibleCaptures++; return { stdout: "VISIBLE_ALT", stderr: "", code: 0 }; }
      return { stdout: "", stderr: "", code: 0 };
    };
    const b = new SessionBroadcaster(`unknown-mode-${geometry.length}-${Date.now()}`, run, true);
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    try {
      await b.start(); appendFileSync(b.logPath, "\x1b[?1049hALT_FALLBACK");
      const end = Date.now() + 1000; while (b.bytesBroadcast() === 0 && Date.now() < end) await Bun.sleep(5);
      expect(b.bytesBroadcast()).toBeGreaterThan(0);
      const frames: Uint8Array[] = [];
      await b.attachWithReplay(c => frames.push(c), 80, 24);
      for (const frame of frames) await new Promise<void>(r => term.write(frame, r));
      expect(term.buffer.active.type).toBe("alternate");
      expect(term.buffer.active.getLine(0)?.translateToString(true)).toContain("ALT_FALLBACK");
      expect(visibleCaptures).toBe(0);
    } finally { term.dispose(); await b.stop({ deleteLog: true }); }
  });
}
