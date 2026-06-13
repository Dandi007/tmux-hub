import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Terminal } from "@xterm/headless";

// Isolate: private log dir so we never touch ~/.cache/tmux-hub.
const dir = mkdtempSync(join(tmpdir(), "emu-size-"));
process.env.TMUX_HUB_LOG_DIR = dir;

// Real-tmux end-to-end regression for the cross-width garble bug (the third
// "still garbled" report). The snapshot is now seeded from `tmux capture-pane`,
// which tmux reflows to the pane's CURRENT size — so content authored at a wide
// width and viewed after a resize to a narrower width comes back CLEAN (wrapped,
// not overlaid/stacked). The old emulator-serialize-of-log path garbled this.
//
// Uses a private tmux socket so we never touch the user's tmux server, and skips
// when tmux is unavailable (e.g. CI without tmux installed).
const HAS_TMUX = Bun.spawnSync(["tmux", "-V"]).exitCode === 0;
const socket = `hubtest-${process.pid}-${Math.floor(performance.now())}`;
const T = (args: string[]) => Bun.spawnSync(["tmux", "-L", socket, ...args]);
// Inject as the broadcaster's tmux runner so it talks to the SAME private socket.
const run = async (args: string[]) => {
  const p = Bun.spawnSync(["tmux", "-L", socket, ...args]);
  return {
    stdout: new TextDecoder().decode(p.stdout).trimEnd(),
    stderr: new TextDecoder().decode(p.stderr).trimEnd(),
    code: p.exitCode,
  };
};

async function renderToLines(snapshot: string, cols: number, rows: number): Promise<string[]> {
  const t = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true });
  await new Promise<void>((r) => t.write(snapshot, r));
  const b = t.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? "");
  return out;
}

test.skipIf(!HAS_TMUX)(
  "snapshot reflects the current (resized) pane width — wide history does not garble",
  async () => {
    const { SessionBroadcaster } = await import("../../src/server/output-broadcaster");
    const SESS = "widefit";
    // Pane authored WIDE: 180 columns.
    T(["new-session", "-d", "-x", "180", "-y", "40", "-s", SESS, "sh"]);
    try {
      const b = new SessionBroadcaster(SESS, run as any, true);
      await b.start();

      // Print a 180-char marker line + a tail marker so we can find it post-reflow.
      T(["send-keys", "-t", `${SESS}:0.0`, "printf 'L%.0s' $(seq 1 178); printf 'END\\n'", "Enter"]);

      // Wait until the wide line is actually on the pane (deterministic, not a sleep).
      const deadline = Date.now() + 3000;
      let captured = "";
      while (Date.now() < deadline) {
        captured = new TextDecoder().decode(T(["capture-pane", "-p", "-t", `${SESS}:0.0`]).stdout);
        if (captured.includes("END")) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(captured).toContain("END");

      // Now RESIZE the pane narrow (90 cols) — as a web client pinning a smaller
      // viewport would. tmux reflows its buffer to 90.
      T(["resize-window", "-t", SESS, "-x", "90", "-y", "40"]);
      await new Promise((r) => setTimeout(r, 50));

      // Attach at the new width and render the snapshot into a 90-col grid.
      const frames: string[] = [];
      await b.attachWithReplay(
        (c: Uint8Array | string) => frames.push(typeof c === "string" ? c : new TextDecoder().decode(c)),
        90,
        40,
      );
      const snap = frames[0] ?? "";
      const lines = await renderToLines(snap, 90, 40);

      // No rendered row may exceed the 90-col grid (a wide rule clamped/overlaid
      // at the old 180 width would corrupt rows; clean reflow keeps every row ≤90).
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(90);

      // The 178-char L-run + "END" is preserved intact, just re-wrapped across
      // 90-col rows. Joining the (full, untrimmed-mid-wrap) rows reconstructs it.
      const joined = lines.join("");
      // The long L-run survives intact (≥170 of 178) — a width-mismatch overlay
      // would have clobbered the middle with stale wide-rule chars. (Match the
      // long run specifically; the echoed command line also contains a lone "L".)
      const lRun = joined.match(/L{100,}/)?.[0] ?? "";
      expect(lRun.length).toBeGreaterThanOrEqual(170);
      expect(joined).toContain("LEND"); // the END marker stays attached to the run

      await b.stop({ deleteLog: true });
    } finally {
      T(["kill-server"]);
    }
  },
);
