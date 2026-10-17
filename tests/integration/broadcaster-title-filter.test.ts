import { test, expect } from "bun:test";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TMUX_HUB_LOG_DIR = mkdtempSync(join(tmpdir(), "title-filter-"));
const dec = (c: Uint8Array) => new TextDecoder().decode(c);

async function waitFor(cond: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
}

// Live subscribers must not receive screen's `ESC k <name> ESC \` (xterm.js
// would print <name>); see src/server/title-seq-filter.ts.
test("live bytes reach subscribers without the screen window-name sequence", async () => {
  const { SessionBroadcaster } = await import("../../src/server/output-broadcaster");
  const b = new SessionBroadcaster("title-1", (async () => ({ stdout: "", stderr: "", code: 0 })) as any, true);
  await b.start();
  const got: string[] = [];
  await b.attachWithReplay((c) => got.push(dec(c)), 80, 24);
  got.length = 0; // drop the attach snapshot; only live bytes matter here
  appendFileSync(b.logPath, "before\x1bkprint");
  await new Promise((r) => setTimeout(r, 30)); // split across polls
  appendFileSync(b.logPath, "f\x1b\\after\x1b");
  await waitFor(() => got.join("").endsWith("\x1b"));
  expect(got.join("")).toBe("beforeafter\x1b"); // the trailing lone ESC is released, not held forever
  await b.stop({ deleteLog: true });
});
