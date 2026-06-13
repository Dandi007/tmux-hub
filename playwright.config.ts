import { defineConfig, devices } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const E2E_PORT = "3201";
const E2E_EMU_PORT = "3202";

// playwright.config.ts can be loaded multiple times in one invocation (per project,
// per worker). All loads must agree on identity. Workers run in distinct processes
// and DO inherit env vars from the runner. We use a fixed-path env file (one per
// checkout dir) so reloads and workers all read the same JSON. Single-checkout
// invariant — distinct checkouts get distinct files via cwd hash.
const cwdHash = Buffer.from(process.cwd()).toString("base64url").slice(0, 12);
const E2E_ENV_FILE = join(tmpdir(), `tmux-hub-e2e-env-${cwdHash}.json`);
// Separate env file for the emulator project so it gets its own socket/dirs/port.
export const E2E_EMU_ENV_FILE = join(tmpdir(), `tmux-hub-e2e-emu-env-${cwdHash}.json`);

type E2EEnv = { socket: string; tmuxTmpdir: string; secretPath: string; logDir: string; dbPath: string; port: string };

function makeEnv(file: string, suffix: string, port: string): E2EEnv {
  if (existsSync(file)) {
    return JSON.parse(readFileSync(file, "utf8")) as E2EEnv;
  }
  const id = `${process.pid}-${Date.now()}-${suffix}`;
  const e: E2EEnv = {
    socket: `hub-e2e-${id}`,
    tmuxTmpdir: `/tmp/tht-e2e-${id}`,
    secretPath: `/tmp/tht-e2e-secret-${id}/hub.secret`,
    logDir: `/tmp/tht-e2e-logs-${id}`,
    dbPath: `/tmp/tht-e2e-${id}/managed-sessions.db`,
    port,
  };
  mkdirSync(e.tmuxTmpdir, { recursive: true });
  mkdirSync(`/tmp/tht-e2e-secret-${id}`, { recursive: true });
  mkdirSync(e.logDir, { recursive: true });
  writeFileSync(file, JSON.stringify(e));
  return e;
}

const env = makeEnv(E2E_ENV_FILE, "main", E2E_PORT);
const emuEnv = makeEnv(E2E_EMU_ENV_FILE, "emu", E2E_EMU_PORT);

process.env.TMUX_HUB_E2E_ENV_FILE = E2E_ENV_FILE;
process.env.TMUX_HUB_E2E_EMU_ENV_FILE = E2E_EMU_ENV_FILE;

const { socket: E2E_SOCKET, tmuxTmpdir: E2E_TMUX_TMPDIR, secretPath: E2E_SECRET_PATH, logDir: E2E_LOG_DIR, dbPath: E2E_DB_PATH } = env;
const { socket: EMU_SOCKET, tmuxTmpdir: EMU_TMUX_TMPDIR, secretPath: EMU_SECRET_PATH, logDir: EMU_LOG_DIR, dbPath: EMU_DB_PATH } = emuEnv;

function hubCommand(opts: {
  socket: string; tmpdir: string; secretPath: string; logDir: string; dbPath: string; port: string; emulator?: boolean;
}): string {
  return (
    `TMUX_HUB_SOCKET=${opts.socket} ` +
    `TMUX_TMPDIR=${opts.tmpdir} ` +
    `TMUX_HUB_TEMPLATES_PATH=deploy/templates.yaml.example ` +
    `TMUX_HUB_DEV_BIND_SECRET=1 ` +
    `TMUX_HUB_SECRET_PATH=${opts.secretPath} ` +
    `TMUX_HUB_LOG_DIR=${opts.logDir} ` +
    `TMUX_HUB_DB_PATH=${opts.dbPath} ` +
    `TMUX_HUB_PORT=${opts.port} ` +
    (opts.emulator ? `TMUX_HUB_EMULATOR=1 ` : ``) +
    `bun run start`
  );
}

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  webServer: [
    {
      command: hubCommand({
        socket: E2E_SOCKET, tmpdir: E2E_TMUX_TMPDIR, secretPath: E2E_SECRET_PATH,
        logDir: E2E_LOG_DIR, dbPath: E2E_DB_PATH, port: E2E_PORT,
      }),
      url: `http://127.0.0.1:${E2E_PORT}/system/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
      env: { TMUX_HUB_E2E_ENV_FILE: E2E_ENV_FILE },
    },
    {
      command: hubCommand({
        socket: EMU_SOCKET, tmpdir: EMU_TMUX_TMPDIR, secretPath: EMU_SECRET_PATH,
        logDir: EMU_LOG_DIR, dbPath: EMU_DB_PATH, port: E2E_EMU_PORT, emulator: true,
      }),
      url: `http://127.0.0.1:${E2E_EMU_PORT}/system/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
      env: { TMUX_HUB_E2E_ENV_FILE: E2E_EMU_ENV_FILE },
    },
  ],
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
    {
      name: "emulator",
      testMatch: /emulator-tui\.e2e\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        baseURL: `http://127.0.0.1:${E2E_EMU_PORT}`,
      },
    },
  ],
});
