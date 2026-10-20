import { test, expect } from "bun:test";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate: private log dir so we never touch ~/.cache/tmux-hub.
process.env.TMUX_HUB_LOG_DIR = mkdtempSync(join(tmpdir(), "emu-align-"));

const dec = (c: Uint8Array | string) => (typeof c === "string" ? c : new TextDecoder().decode(c));

async function waitFor(cond: () => boolean, ms = 500): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
}

// Root cause of the fidelity-oracle fixme "attach that resizes a running TUI":
// bytes that tmux had ALREADY rendered when capture-pane ran (so they are part
// of the snapshot) were still in flight through pipe-pane → log file → poll,
// and got re-applied on top of the snapshot. Relative moves (CR/LF, CUU, zsh
// PROMPT_SP) are not idempotent, so the screen shifted permanently. Here the
// fake capture-pane simulates that: the first capture "sees" a redraw whose
// bytes land in the log just after it returns.
test("bytes in flight during capture are not replayed on top of the snapshot", async () => {
  const { SessionBroadcaster } = await import("../../src/server/output-broadcaster");
  let captures = 0;
  let logPath = "";
  const run = async (args: string[]) => {
    if (args[0] === "display-message") return { stdout: "0 0 0 24 0 0 0", stderr: "", code: 0 };
    if (args[0] === "capture-pane") {
      captures++;
      if (captures === 1) appendFileSync(logPath, "\r\nIN_FLIGHT_REDRAW");
      return { stdout: `SNAPSHOT_${captures}`, stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  const b = new SessionBroadcaster("align-1", run as any, true);
  logPath = b.logPath;
  await b.start();

  const { snapshotStats } = await import("../../src/server/output-broadcaster");
  const before = { ...snapshotStats };
  const frames: string[] = [];
  await b.attachWithReplay((c: Uint8Array | string) => frames.push(dec(c)), 120, 40);
  const all = frames.join("");
  expect(snapshotStats.snapshots - before.snapshots).toBe(1);
  expect(snapshotStats.retries - before.retries).toBe(1);
  expect(snapshotStats.overlaps - before.overlaps).toBe(0);

  expect(all).not.toContain("IN_FLIGHT_REDRAW");
  expect(all).toContain("SNAPSHOT_2");
  expect(all.startsWith("\x1bc")).toBe(true);

  // Live bytes after the attach still flow.
  appendFileSync(logPath, "LIVE_AFTER");
  await waitFor(() => frames.join("").includes("LIVE_AFTER"));
  expect(frames.join("")).toContain("LIVE_AFTER");

  await b.stop({ deleteLog: true });
});

// A quiet pane needs exactly one capture: the alignment check must not add
// round-trips when nothing is streaming.
test("a quiet pane is captured once", async () => {
  const { SessionBroadcaster } = await import("../../src/server/output-broadcaster");
  let captures = 0;
  const run = async (args: string[]) => {
    if (args[0] === "display-message") return { stdout: "0 0 0 24 0 0 0", stderr: "", code: 0 };
    if (args[0] === "capture-pane") { captures++; return { stdout: "QUIET", stderr: "", code: 0 }; }
    return { stdout: "", stderr: "", code: 0 };
  };
  const b = new SessionBroadcaster("align-2", run as any, true);
  await b.start();
  const { snapshotStats } = await import("../../src/server/output-broadcaster");
  const before = { ...snapshotStats };
  const frames: string[] = [];
  await b.attachWithReplay((c: Uint8Array | string) => frames.push(dec(c)), 120, 40);
  expect(captures).toBe(1);
  expect(snapshotStats.snapshots - before.snapshots).toBe(1);
  expect(snapshotStats.retries - before.retries).toBe(0);
  expect(frames.join("")).toContain("QUIET");
  await b.stop({ deleteLog: true });
});

// A pane that never goes quiet (continuous output) must still attach within a
// bounded number of captures, and must not lose bytes: the last capture's
// trailing bytes are delivered (the pre-fix behaviour) rather than dropped.
test("a never-quiet pane attaches after bounded retries without losing bytes", async () => {
  const { SessionBroadcaster } = await import("../../src/server/output-broadcaster");
  let captures = 0;
  let logPath = "";
  const run = async (args: string[]) => {
    if (args[0] === "display-message") return { stdout: "0 0 0 24 0 0 0", stderr: "", code: 0 };
    if (args[0] === "capture-pane") {
      captures++;
      appendFileSync(logPath, `STREAM_${captures};`);
      return { stdout: `SNAP_${captures}`, stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  const b = new SessionBroadcaster("align-3", run as any, true);
  logPath = b.logPath;
  await b.start();
  const { snapshotStats } = await import("../../src/server/output-broadcaster");
  const before = { ...snapshotStats };
  const frames: string[] = [];
  await b.attachWithReplay((c: Uint8Array | string) => frames.push(dec(c)), 120, 40);
  const all = frames.join("");
  // The fallback is what can leave a client misaligned: it must be counted.
  expect(snapshotStats.overlaps - before.overlaps).toBe(1);
  expect(snapshotStats.retries - before.retries).toBe(captures - 1);
  expect(captures).toBeGreaterThan(1);
  expect(captures).toBeLessThanOrEqual(6);
  expect(all).toContain(`SNAP_${captures}`);
  await waitFor(() => frames.join("").includes(`STREAM_${captures};`));
  expect(frames.join("")).toContain(`STREAM_${captures};`);
  await b.stop({ deleteLog: true });
});

// capture-pane leaves the client cursor below the last captured line, and a
// replayed DECSTBM homes it; neither is where the app's cursor is. Output that
// follows the attach with relative moves (zsh redrawing its prompt after the
// attach pin's SIGWINCH) then lands on the wrong row — the fresh-shell attach
// showed the prompt twice. The restore stream must end with an absolute CUP to
// tmux's cursor, after the modes.
test("snapshot ends by restoring tmux's cursor position", async () => {
  const { SessionBroadcaster } = await import("../../src/server/output-broadcaster");
  const run = async (args: string[]) => {
    if (args[0] === "capture-pane") return { stdout: "PROMPT", stderr: "", code: 0 };
    if (args[0] === "display-message" && args.some((a) => a.includes("cursor_x"))) {
      return { stdout: "5 3 0 40 0 0 0\n", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  const b = new SessionBroadcaster("align-4", run as any, true);
  await b.start();
  await Bun.write(b.logPath, "\x1b[2;20r");
  await waitFor(() => b.bytesBroadcast() > 0);
  const frames: string[] = [];
  await b.attachWithReplay((c: Uint8Array | string) => frames.push(dec(c)), 120, 40);
  const snap = frames.join("");
  expect(snap).toContain("PROMPT");
  expect(snap.endsWith("\x1b[4;6H")).toBe(true);
  await b.stop({ deleteLog: true });
});

// resync re-delivers an aligned snapshot to an already-attached subscriber:
// announce() first (so the client saves its scroll position), then the
// snapshot, then live bytes keep flowing to the same subscriber.
test("resync re-sends a snapshot to an attached subscriber, announced first", async () => {
  const { SessionBroadcaster } = await import("../../src/server/output-broadcaster");
  let captures = 0;
  const run = async (args: string[]) => {
    if (args[0] === "display-message") return { stdout: "0 0 0 24 0 0 0", stderr: "", code: 0 };
    if (args[0] === "capture-pane") { captures++; return { stdout: `SNAP_${captures}`, stderr: "", code: 0 }; }
    return { stdout: "", stderr: "", code: 0 };
  };
  const b = new SessionBroadcaster("align-5", run as any, true);
  await b.start();
  const frames: string[] = [];
  const send = (c: Uint8Array | string) => frames.push(dec(c));
  const unsub = await b.attachWithReplay(send, 120, 40);
  await b.resync(send, 90, 30, () => frames.push("ANNOUNCE"));
  const all = frames.join("|");
  expect(all.indexOf("ANNOUNCE")).toBeGreaterThan(all.indexOf("SNAP_1"));
  expect(all.indexOf("SNAP_2")).toBeGreaterThan(all.indexOf("ANNOUNCE"));
  expect(b.subscriberCount()).toBe(1);

  appendFileSync(b.logPath, "LIVE_AFTER_RESYNC");
  await waitFor(() => frames.join("").includes("LIVE_AFTER_RESYNC"));
  expect(frames.join("")).toContain("LIVE_AFTER_RESYNC");

  // A detached subscriber is not resurrected by a late resync.
  unsub();
  await b.resync(send, 80, 30, () => frames.push("LATE"));
  expect(frames).not.toContain("LATE");
  expect(b.subscriberCount()).toBe(0);
  await b.stop({ deleteLog: true });
});

// The legacy byte-replay path cannot produce a reflowed snapshot; replaying
// the width-frozen log would be worse than the drift, so resync is a no-op.
test("resync is a no-op on the legacy (emulator off) path", async () => {
  const { SessionBroadcaster } = await import("../../src/server/output-broadcaster");
  const b = new SessionBroadcaster("align-6", (async () => ({ stdout: "", stderr: "", code: 0 })) as any, false);
  await b.start();
  const frames: string[] = [];
  const send = (c: Uint8Array | string) => frames.push(dec(c));
  await b.attachWithReplay(send, 120, 40);
  const before = frames.length;
  await b.resync(send, 90, 30, () => frames.push("ANNOUNCE"));
  expect(frames.length).toBe(before);
  await b.stop({ deleteLog: true });
});

// capture-pane terminates EVERY line with "\n", including the last visible
// row. Converted verbatim, that final CRLF scrolls the client one extra line:
// the whole restored screen sits one row too high (top row pushed into
// scrollback, blank bottom row) while the CUP still points at tmux's row.
// Seen as a doubled zsh prompt after a resize resync (xterm-headless repro:
// baseY = history + 1). The body must end without a line terminator.
test("the snapshot body does not end with a line terminator", async () => {
  const { SessionBroadcaster } = await import("../../src/server/output-broadcaster");
  const run = async (args: string[]) => {
    if (args[0] === "capture-pane") return { stdout: "HIST\nROW0\nROW1\n", stderr: "", code: 0 };
    if (args[0] === "display-message") return { stdout: "0 1 0 24 0 0 0\n", stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  };
  const b = new SessionBroadcaster("align-7", run as any, true);
  await b.start();
  const frames: string[] = [];
  await b.attachWithReplay((c: Uint8Array | string) => frames.push(dec(c)), 120, 2);
  const snap = frames.join("");
  expect(snap).toContain("HIST\r\nROW0\r\nROW1");
  expect(snap).not.toContain("ROW1\r\n");
  await b.stop({ deleteLog: true });
});
