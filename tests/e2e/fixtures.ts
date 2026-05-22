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

function loadE2EEnv(): E2EEnv {
  const cwdHash = Buffer.from(process.cwd()).toString("base64url").slice(0, 12);
  const envFile = process.env.TMUX_HUB_E2E_ENV_FILE ?? join(tmpdir(), `tmux-hub-e2e-env-${cwdHash}.json`);
  if (!existsSync(envFile)) {
    throw new Error(`E2E env file not found at ${envFile} — run via playwright.config.ts`);
  }
  return JSON.parse(readFileSync(envFile, "utf8")) as E2EEnv;
}

export const test = base.extend<{ ctx: Ctx }>({
  ctx: async ({}, use) => {
    const { socket, tmuxTmpdir } = loadE2EEnv();
    if (!existsSync(tmuxTmpdir)) mkdirSync(tmuxTmpdir, { recursive: true });

    const env = { ...process.env, TMUX_TMPDIR: tmuxTmpdir };
    const tmuxE2E = (args: string[]): string => {
      const r = spawnSync("tmux", ["-L", socket, ...args], { env, encoding: "utf8" });
      if (r.status !== 0) {
        if (!/no server|no sessions|can't find/i.test(r.stderr ?? "")) {
          throw new Error(`tmux -L ${socket} ${args.join(" ")} failed (${r.status}): ${r.stderr}`);
        }
      }
      return (r.stdout ?? "").trimEnd();
    };

    await use({ socket, tmuxTmpdir, tmuxE2E });
  },
});

export { expect };
