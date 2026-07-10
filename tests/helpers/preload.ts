// tests/helpers/preload.ts
// Global bun-test preload (wired via bunfig.toml [test].preload).
//
// Forces every prod-state knob to an isolated temp root BEFORE any test file
// or src module is imported. Module-level constants (output-broadcaster's
// LOG_DIR, managed-db's default path, tmux-cmd's socket) resolve from
// process.env at first import and are then frozen by the module cache, so
// per-test-file env assignment is unreliable: whichever file imports the
// module first wins. This preload is the only ordering-safe place to set them.
//
// Incident 2026-07-10: a local `bun run test` opened the production
// managed-sessions.db (bare `new ManagedSessionDb()`) and its SessionRegistry
// pruned every live session row, which made the prod hub emit session_removed
// and delete the sessions' replay logs. Tests must never reach prod state.
import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "tmux-hub-test-"));

process.env.TMUX_HUB_DB_PATH = join(root, "managed-sessions.db");
process.env.TMUX_HUB_LOG_DIR = join(root, "logs");
process.env.TMUX_TMPDIR = join(root, "tmux-sockets");
process.env.TMUX_HUB_SOCKET = `hub-test-preload-${process.pid}`;
mkdirSync(process.env.TMUX_HUB_LOG_DIR, { recursive: true });
mkdirSync(process.env.TMUX_TMPDIR, { recursive: true });

// Guard: if any knob still resolves into prod state, refuse to run at all.
const prodCache = resolve(homedir(), ".cache/tmux-hub");
for (const [key, value] of Object.entries({
  TMUX_HUB_DB_PATH: process.env.TMUX_HUB_DB_PATH,
  TMUX_HUB_LOG_DIR: process.env.TMUX_HUB_LOG_DIR,
  TMUX_TMPDIR: process.env.TMUX_TMPDIR,
})) {
  if (!value || resolve(value).startsWith(prodCache)) {
    throw new Error(`[test-preload] ${key} resolves into prod state (${value}); aborting test run`);
  }
}
if (process.env.TMUX_HUB_SOCKET === "tmux-hub") {
  throw new Error("[test-preload] TMUX_HUB_SOCKET is the production socket; aborting test run");
}
