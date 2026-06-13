import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate: private log dir so we never touch ~/.cache/tmux-hub.
const dir = mkdtempSync(join(tmpdir(), "emu-attach-"));
process.env.TMUX_HUB_LOG_DIR = dir;

// Fake tmux runner: pipe-pane succeeds; capture-pane returns the authoritative
// (correctly-reflowed) screen — the broadcaster seeds the snapshot from this,
// not from a replay of the on-disk log.
const fakeRun = async (args: string[]) => {
  if (args[0] === "capture-pane") {
    return { stdout: "echo hi\nhi\n\x1b[31mRED\x1b[0m", stderr: "", code: 0 };
  }
  return { stdout: "", stderr: "", code: 0 };
};

test("attach with EMULATOR_ENABLED sends a coherent snapshot, not a raw slice", async () => {
  const { SessionBroadcaster } = await import("../../src/server/output-broadcaster");
  // Pin the emulator path explicitly via the constructor seam — independent of
  // TMUX_HUB_EMULATOR env / module-cache load order across the full suite.
  const b = new SessionBroadcaster("emu-attach-1", fakeRun as any, true);
  await b.start();
  // stale log bytes must NOT be the snapshot source (capture-pane is)
  await Bun.write(b.logPath, "stale-log-bytes\r\n");

  // Deterministic wait: poll until broadcaster has ingested at least one byte,
  // with a 500 ms safety timeout instead of a fixed sleep.
  const deadline = Date.now() + 500;
  while (b.bytesBroadcast() === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }

  const frames: string[] = [];
  await b.attachWithReplay((chunk: Uint8Array | string) => {
    frames.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
  });
  const first = frames[0] ?? "";
  // snapshot starts with a hard reset and reproduces the captured screen text
  expect(first.startsWith("\x1bc")).toBe(true);
  expect(first).toContain("RED");
  expect(first).toContain("hi");

  await b.stop({ deleteLog: true });
});
