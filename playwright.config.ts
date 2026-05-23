import { defineConfig, devices } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const E2E_PORT = "3201";

// playwright.config.ts can be loaded multiple times in one invocation (per project,
// per worker). All loads must agree on identity. Workers run in distinct processes
// and DO inherit env vars from the runner. We use a fixed-path env file (one per
// checkout dir) so reloads and workers all read the same JSON. Single-checkout
// invariant — distinct checkouts get distinct files via cwd hash.
const cwdHash = Buffer.from(process.cwd()).toString("base64url").slice(0, 12);
const E2E_ENV_FILE = join(tmpdir(), `tmux-hub-e2e-env-${cwdHash}.json`);

type E2EEnv = { socket: string; tmuxTmpdir: string; secretPath: string; logDir: string; port: string };
let env: E2EEnv;
if (existsSync(E2E_ENV_FILE)) {
  env = JSON.parse(readFileSync(E2E_ENV_FILE, "utf8")) as E2EEnv;
} else {
  const id = `${process.pid}-${Date.now()}`;
  env = {
    socket: `hub-e2e-${id}`,
    tmuxTmpdir: `/tmp/tht-e2e-${id}`,
    secretPath: `/tmp/tht-e2e-secret-${id}/hub.secret`,
    logDir: `/tmp/tht-e2e-logs-${id}`,
    port: E2E_PORT,
  };
  mkdirSync(env.tmuxTmpdir, { recursive: true });
  mkdirSync(`/tmp/tht-e2e-secret-${id}`, { recursive: true });
  mkdirSync(env.logDir, { recursive: true });
  writeFileSync(E2E_ENV_FILE, JSON.stringify(env));
}
process.env.TMUX_HUB_E2E_ENV_FILE = E2E_ENV_FILE;

const { socket: E2E_SOCKET, tmuxTmpdir: E2E_TMUX_TMPDIR, secretPath: E2E_SECRET_PATH, logDir: E2E_LOG_DIR } = env;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  webServer: {
    command:
      `TMUX_HUB_SOCKET=${E2E_SOCKET} ` +
      `TMUX_TMPDIR=${E2E_TMUX_TMPDIR} ` +
      `TMUX_HUB_TEMPLATES_PATH=deploy/templates.yaml.example ` +
      `TMUX_HUB_DEV_BIND_SECRET=1 ` +
      `TMUX_HUB_SECRET_PATH=${E2E_SECRET_PATH} ` +
      `TMUX_HUB_LOG_DIR=${E2E_LOG_DIR} ` +
      `TMUX_HUB_PORT=${E2E_PORT} ` +
      `bun run start`,
    url: `http://127.0.0.1:${E2E_PORT}/system/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: "pipe",
    stderr: "pipe",
    env: { TMUX_HUB_E2E_ENV_FILE: E2E_ENV_FILE },
  },
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    trace: process.env.CI ? "retain-on-failure" : "off",
  },
  projects: [
    {
      name: "desktop",
      testMatch: /(desktop|key-conformance)\.e2e\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "pwa",
      testMatch: /pwa\.e2e\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile",
      testMatch: /mobile\.e2e\.ts/,
      use: { ...devices["iPhone 14"] },
    },
  ],
});
