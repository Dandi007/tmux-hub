import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Terminal } from "@xterm/headless";

// Isolate: private log dir so we never touch ~/.cache/tmux-hub.
const dir = mkdtempSync(join(tmpdir(), "emu-size-"));
process.env.TMUX_HUB_LOG_DIR = dir;

// Fake tmux runner: pipe-pane succeeds; we drive the log file ourselves.
const fakeRun = async () => ({ stdout: "", stderr: "", code: 0 });

// Render a restore-stream snapshot into a terminal of the given width and
// return row 0 of the visible screen.
async function renderLine0(snapshot: string, cols: number, rows = 77): Promise<string> {
  const t = new Terminal({ cols, rows, allowProposedApi: true });
  await new Promise<void>((r) => t.write(snapshot, r));
  const b = t.buffer.active;
  return b.getLine(b.viewportY)?.translateToString(true) ?? "";
}

// Regression for the overlapping-box garble bug: the emulator must be built at
// the ACTUAL pane width, not the fixed WINDOW_COLS (200) default. A wide pane
// (>200 cols) renders absolute cursor moves to columns >200; a 200-col
// emulator clamps them to the right edge and wraps wide rules, corrupting the
// serialized snapshot. attachWithReplay must honor the pane size it is given.
test("emulator snapshot honors the attach pane width (no clamp at WINDOW_COLS)", async () => {
  const { SessionBroadcaster } = await import("../../src/server/output-broadcaster");
  const b = new SessionBroadcaster("emu-size-1", fakeRun as any, true);
  await b.start();
  // Move to row 1, col 250 (well beyond the 200-col default) and print a marker.
  await Bun.write(b.logPath, "\x1b[1;250HMARK\r\n");

  const deadline = Date.now() + 500;
  while (b.bytesBroadcast() === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }

  const frames: string[] = [];
  b.attachWithReplay(
    (chunk: Uint8Array | string) =>
      frames.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)),
    300,
    77,
  );
  const snap = frames[0] ?? "";
  const line0 = await renderLine0(snap, 300);
  // MARK must sit at column 250 (0-based index 249). With a 200-col emulator the
  // CUP clamps to col 200 and MARK wraps/splits → index !== 249.
  expect(line0.indexOf("MARK")).toBe(249);

  await b.stop({ deleteLog: true });
});

// A second attach at a different pane width must re-size the live emulator so a
// subsequent snapshot is coherent at the new width (single-active sizing).
test("a later attach at a new width re-sizes the live emulator", async () => {
  const { SessionBroadcaster } = await import("../../src/server/output-broadcaster");
  const b = new SessionBroadcaster("emu-size-2", fakeRun as any, true);
  await b.start();
  await Bun.write(b.logPath, "\x1b[1;120HFIRST\r\n");
  const deadline = Date.now() + 500;
  while (b.bytesBroadcast() === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }

  // First attach builds the emulator at 150 cols.
  b.attachWithReplay(() => {}, 150, 40);
  // Second attach at 300 cols must resize the emulator; a CUP to col 250 now
  // lands correctly instead of being clamped to the old 150-col grid.
  const frames: string[] = [];
  b.syncEmulatorSize(300, 77);
  // Feed a wide write after the resize and snapshot via a fresh attach.
  await Bun.write(b.logPath, "\x1b[1;120HFIRST\r\n\x1b[2;250HWIDE\r\n");
  await new Promise((r) => setTimeout(r, 30));
  b.attachWithReplay(
    (chunk: Uint8Array | string) =>
      frames.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)),
    300,
    77,
  );
  const snap = frames[0] ?? "";
  const t = new Terminal({ cols: 300, rows: 77, allowProposedApi: true });
  await new Promise<void>((r) => t.write(snap, r));
  const buf = t.buffer.active;
  const row1 = buf.getLine(buf.viewportY + 1)?.translateToString(true) ?? "";
  expect(row1.indexOf("WIDE")).toBe(249);

  await b.stop({ deleteLog: true });
});
