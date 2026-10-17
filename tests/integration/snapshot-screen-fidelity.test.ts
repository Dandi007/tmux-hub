import { test, expect, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Terminal } from "@xterm/headless";

// Isolate: private log dir so we never touch ~/.cache/tmux-hub.
process.env.TMUX_HUB_LOG_DIR = mkdtempSync(join(tmpdir(), "snap-fid-"));

// Real-tmux regression: a restore stream rendered by xterm must reproduce the
// pane exactly — visible rows at the same rows, history in scrollback, cursor
// in place. The runner trims stdout (like src/server/tmux-cmd.ts), so a
// screen whose bottom rows are blank came back short: nothing scrolled the
// history off the screen and it was drawn ON it (a fresh zsh after a resize
// showed its PROMPT_SP line and old prompts above the live one). A full screen
// was off by one the other way.
const HAS_TMUX = Bun.spawnSync(["tmux", "-V"]).exitCode === 0;
const socket = `hubsnap-${process.pid}-${Math.floor(performance.now())}`;
const T = (args: string[]) => new TextDecoder().decode(Bun.spawnSync(["tmux", "-L", socket, ...args]).stdout);
const run = async (args: string[]) => {
  const p = Bun.spawnSync(["tmux", "-L", socket, ...args]);
  return {
    stdout: new TextDecoder().decode(p.stdout).trimEnd(),
    stderr: new TextDecoder().decode(p.stderr).trimEnd(),
    code: p.exitCode,
  };
};
afterAll(() => { Bun.spawnSync(["tmux", "-L", socket, "kill-server"]); });

const norm = (ls: string[]) => ls.map((l) => l.replace(/\s+$/, ""));

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
}

async function checkPane(sess: string, cols: number, rows: number): Promise<void> {
  const { SessionBroadcaster } = await import("../../src/server/output-broadcaster");
  const b = new SessionBroadcaster(sess, run as any, true);
  await b.start();
  try {
    const frames: Uint8Array[] = [];
    await b.attachWithReplay((c) => frames.push(c), cols, rows);
    const term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
    for (const f of frames) await new Promise<void>((r) => term.write(f, r));
    const buf = term.buffer.active;
    const visible: string[] = [];
    for (let y = 0; y < rows; y++) visible.push(buf.getLine(buf.baseY + y)?.translateToString(true) ?? "");
    const tmuxVisible = T(["capture-pane", "-p", "-t", `${sess}:0.0`]).split("\n").slice(0, rows);
    while (tmuxVisible.length < rows) tmuxVisible.push("");
    expect(norm(visible)).toEqual(norm(tmuxVisible));

    const [cx, cy, hs] = T(["display-message", "-p", "-t", `${sess}:0.0`, "#{cursor_x} #{cursor_y} #{history_size}"]).trim().split(" ").map(Number);
    expect([buf.cursorX, buf.cursorY]).toEqual([cx!, cy!]);
    expect(buf.baseY).toBe(hs!);
    if (hs! > 0) {
      const lastHist = T(["capture-pane", "-p", "-t", `${sess}:0.0`, "-S", "-1", "-E", "-1"]).replace(/\n$/, "");
      expect((buf.getLine(buf.baseY - 1)?.translateToString(true) ?? "").replace(/\s+$/, "")).toBe(lastHist.replace(/\s+$/, ""));
    }
  } finally {
    await b.stop({ deleteLog: true });
  }
}

function newPane(sess: string, cols: number, rows: number): void {
  T(["new-session", "-d", "-x", String(cols), "-y", String(rows), "-s", sess, "env PS1='$ ' sh"]);
}

test.skipIf(!HAS_TMUX)("history above a mostly blank screen stays in scrollback", async () => {
  newPane("partial", 60, 10);
  T(["send-keys", "-t", "partial:0.0", "seq 1 25; printf '\\033[2J\\033[H'", "Enter"]);
  await waitFor(() => T(["capture-pane", "-p", "-t", "partial:0.0"]).startsWith("$"));
  await waitFor(() => Number(T(["display-message", "-p", "-t", "partial:0.0", "#{history_size}"])) > 0);
  await checkPane("partial", 60, 10);
});

test.skipIf(!HAS_TMUX)("a full screen with history is not shifted", async () => {
  newPane("full", 60, 10);
  T(["send-keys", "-t", "full:0.0", "seq 1 40", "Enter"]);
  await waitFor(() => T(["capture-pane", "-p", "-t", "full:0.0"]).includes("40\n$"));
  await checkPane("full", 60, 10);
});

test.skipIf(!HAS_TMUX)("a pane without history", async () => {
  newPane("nohist", 60, 10);
  T(["send-keys", "-t", "nohist:0.0", "echo hello", "Enter"]);
  await waitFor(() => T(["capture-pane", "-p", "-t", "nohist:0.0"]).includes("hello\n$"));
  await checkPane("nohist", 60, 10);
});
