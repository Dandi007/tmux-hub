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

  const frames: string[] = [];
  await b.attachWithReplay((c: Uint8Array | string) => frames.push(dec(c)), 120, 40);
  const all = frames.join("");

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
    if (args[0] === "capture-pane") { captures++; return { stdout: "QUIET", stderr: "", code: 0 }; }
    return { stdout: "", stderr: "", code: 0 };
  };
  const b = new SessionBroadcaster("align-2", run as any, true);
  await b.start();
  const frames: string[] = [];
  await b.attachWithReplay((c: Uint8Array | string) => frames.push(dec(c)), 120, 40);
  expect(captures).toBe(1);
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
  const frames: string[] = [];
  await b.attachWithReplay((c: Uint8Array | string) => frames.push(dec(c)), 120, 40);
  const all = frames.join("");
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
      return { stdout: "5 3\n", stderr: "", code: 0 };
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
