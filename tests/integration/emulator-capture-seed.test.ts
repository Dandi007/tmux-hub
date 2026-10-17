import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate: private log dir so we never touch ~/.cache/tmux-hub.
process.env.TMUX_HUB_LOG_DIR = mkdtempSync(join(tmpdir(), "emu-cap-"));

const dec = (c: Uint8Array | string) => (typeof c === "string" ? c : new TextDecoder().decode(c));

// Root-cause regression (third "still garbled" report): the attach snapshot
// must be seeded from tmux's authoritative `capture-pane` render — which tmux
// reflows to the live pane size — NOT by replaying the width-frozen pipe-pane
// log. Replaying history authored at a different width corrupts the screen
// (wrapped wide rules overlay text, stacked rules, fragmented chars). Sourcing
// from capture-pane makes the snapshot match the pane size at any width.
test("attach snapshot is seeded from capture-pane, not from log replay", async () => {
  const { SessionBroadcaster } = await import("../../src/server/output-broadcaster");
  // capture-pane returns clean, authoritative content; everything else ok.
  const run = async (args: string[]) => {
    if (args[0] === "capture-pane") {
      return { stdout: "AUTHORITATIVE_CAPTURE_SCREEN", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  const b = new SessionBroadcaster("cap-seed-1", run as any, true);
  await b.start();

  // The on-disk log holds DIFFERENT content (stand-in for width-frozen history
  // that would garble if replayed). It must NOT leak into the snapshot.
  await Bun.write(b.logPath, "\x1b[1;250HLOG_REPLAY_ONLY\r\n");
  const deadline = Date.now() + 500;
  while (b.bytesBroadcast() === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }

  const frames: string[] = [];
  await b.attachWithReplay((c: Uint8Array | string) => frames.push(dec(c)), 300, 77);
  const snap = frames[0] ?? "";

  expect(snap).toContain("AUTHORITATIVE_CAPTURE_SCREEN");
  expect(snap).not.toContain("LOG_REPLAY_ONLY");
  // Coherent restore stream still starts with a hard reset.
  expect(snap.startsWith("\x1bc")).toBe(true);

  await b.stop({ deleteLog: true });
});

// History is captured separately from the visible screen (see captureSnapshot):
// the pane's history_size bounds a `-S -<N> -E -1` capture, and both captures
// target the session's pane. Pins the capture-pane contract.
test("capture-pane is invoked with scrollback and the session pane target", async () => {
  const { SessionBroadcaster } = await import("../../src/server/output-broadcaster");
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "display-message") return { stdout: "0 0 50 40", stderr: "", code: 0 };
    if (args[0] === "capture-pane") return { stdout: "X", stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  };
  const b = new SessionBroadcaster("cap-seed-2", run as any, true);
  await b.start();
  await Bun.write(b.logPath, "hello\r\n");
  const deadline = Date.now() + 500;
  while (b.bytesBroadcast() === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  await b.attachWithReplay(() => {}, 300, 77);

  const caps = calls.filter((a) => a[0] === "capture-pane");
  for (const cap of caps) {
    expect(cap).toContain("-e"); // include escape sequences (color/SGR)
    expect(cap).toContain("-p"); // print to stdout
    expect(cap.some((a) => a.includes("cap-seed-2"))).toBe(true); // this session's pane
  }
  const hist = caps.find((a) => a.includes("-S"));
  expect(hist).toBeDefined();
  expect(hist![hist!.indexOf("-S") + 1]).toBe("-50"); // bounded by history_size
  expect(hist![hist!.indexOf("-E") + 1]).toBe("-1"); // history only, not the screen
  expect(caps.some((a) => !a.includes("-S"))).toBe(true); // the visible screen

  await b.stop({ deleteLog: true });
});

// Resilience: if capture-pane fails, attach must still send a coherent reset
// snapshot (fall back) rather than nothing.
test("falls back to a reset snapshot when capture-pane fails", async () => {
  const { SessionBroadcaster } = await import("../../src/server/output-broadcaster");
  const run = async (args: string[]) => {
    if (args[0] === "capture-pane") return { stdout: "", stderr: "boom", code: 1 };
    return { stdout: "", stderr: "", code: 0 };
  };
  const b = new SessionBroadcaster("cap-seed-3", run as any, true);
  await b.start();
  await Bun.write(b.logPath, "\x1b[1;5HHELLO\r\n");
  const deadline = Date.now() + 500;
  while (b.bytesBroadcast() === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const frames: string[] = [];
  await b.attachWithReplay((c: Uint8Array | string) => frames.push(dec(c)), 300, 77);
  const snap = frames[0] ?? "";
  // Fallback still begins with a hard reset so the client never renders onto a
  // dirty grid.
  expect(snap.startsWith("\x1bc")).toBe(true);
  await b.stop({ deleteLog: true });
});
