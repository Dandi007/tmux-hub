// Fixtures for the emulator project. Identical shape to fixtures.ts but reads
// the emulator hub's env file (separate socket, port, dirs, TMUX_HUB_EMULATOR=1).
// The env file path is set in playwright.config.ts as TMUX_HUB_E2E_EMU_ENV_FILE
// and inherited by worker processes.
import { test as base, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Ctx = {
  socket: string;
  tmuxTmpdir: string;
  tmuxE2E: (args: string[]) => string;
};

type E2EEnv = {
  socket: string;
  tmuxTmpdir: string;
  secretPath: string;
  port: string;
};

function loadEmuEnv(): E2EEnv {
  // Primary: honour the env var set by playwright.config.ts
  const fromVar = process.env.TMUX_HUB_E2E_EMU_ENV_FILE;
  if (fromVar && existsSync(fromVar)) {
    return JSON.parse(readFileSync(fromVar, "utf8")) as E2EEnv;
  }
  // Fallback: derive the path the same way playwright.config.ts does
  const cwdHash = Buffer.from(process.cwd()).toString("base64url").slice(0, 12);
  const envFile = join(tmpdir(), `tmux-hub-e2e-emu-env-${cwdHash}.json`);
  if (!existsSync(envFile)) {
    throw new Error(
      `Emulator e2e env file not found at ${envFile} — run via playwright.config.ts`,
    );
  }
  return JSON.parse(readFileSync(envFile, "utf8")) as E2EEnv;
}

export const test = base.extend<{ ctx: Ctx }>({
  ctx: async ({}, use) => {
    const { socket, tmuxTmpdir } = loadEmuEnv();
    if (!existsSync(tmuxTmpdir)) mkdirSync(tmuxTmpdir, { recursive: true });

    const env = { ...process.env, TMUX_TMPDIR: tmuxTmpdir };
    const tmuxE2E = (args: string[]): string => {
      const r = spawnSync("tmux", ["-L", socket, ...args], { env, encoding: "utf8" });
      if (r.status !== 0) {
        if (!/no server|no sessions|can't find/i.test(r.stderr ?? "")) {
          throw new Error(
            `tmux -L ${socket} ${args.join(" ")} failed (${r.status}): ${r.stderr}`,
          );
        }
      }
      return (r.stdout ?? "").trimEnd();
    };

    await use({ socket, tmuxTmpdir, tmuxE2E });
  },
});

export { expect };
