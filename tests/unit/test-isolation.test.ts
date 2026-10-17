// tests/unit/test-isolation.test.ts
// Smoke-checks that the global preload (tests/helpers/preload.ts) actually
// isolated every prod-state knob for this test run. If any of these fail,
// the whole suite is unsafe to run on a production host.
import { describe, test, expect } from "bun:test";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { managedDbPath } from "../../src/server/managed-db";
import { scrubAmbientHubEnv } from "../helpers/scrub-env";

const PROD_CACHE = resolve(homedir(), ".cache/tmux-hub");

describe("test-run isolation (preload)", () => {
  test("managed db resolves outside prod state", () => {
    expect(resolve(managedDbPath()).startsWith(PROD_CACHE)).toBe(false);
  });

  test("log dir and tmux tmpdir resolve outside prod state", () => {
    expect(resolve(process.env.TMUX_HUB_LOG_DIR!).startsWith(PROD_CACHE)).toBe(false);
    expect(resolve(process.env.TMUX_TMPDIR!).startsWith(PROD_CACHE)).toBe(false);
  });

  test("ambient socket is not the production socket", () => {
    expect(process.env.TMUX_HUB_SOCKET).toBeTruthy();
    expect(process.env.TMUX_HUB_SOCKET).not.toBe("tmux-hub");
  });

  // A dev shell spawned under a hub carries hub.env (prod HOST, voice.db,
  // suggest/gate credentials). Tests must see the same env as CI regardless.
  test("no ambient hub config leaks into the test process", () => {
    const preloadEnv = (globalThis as { __preloadEnv?: Record<string, string | undefined> }).__preloadEnv;
    expect(preloadEnv).toBeDefined();
    const leaked = Object.keys(preloadEnv!)
      .filter((k) => /^(GATE_|TMUX_HUB_)/.test(k))
      .filter((k) => !["TMUX_HUB_DB_PATH", "TMUX_HUB_LOG_DIR", "TMUX_HUB_SOCKET"].includes(k));
    expect(leaked).toEqual([]);
  });
});

describe("scrubAmbientHubEnv", () => {
  test("removes hub config and gate keys, keeps E2E plumbing and ordinary env", () => {
    const env: Record<string, string | undefined> = {
      PATH: "/usr/bin",
      TMUX_TMPDIR: "/run/tmux",
      TMUX_HUB_HOST: "100.64.0.6",
      TMUX_HUB_VOICE_DB_PATH: "/prod/voice.db",
      TMUX_HUB_SUGGEST: "1",
      GATE_INJECT_KEY: "k",
      TMUX_HUB_E2E_ENV_FILE: "/tmp/e2e.json",
    };
    const removed = scrubAmbientHubEnv(env);
    expect(env).toEqual({ PATH: "/usr/bin", TMUX_TMPDIR: "/run/tmux", TMUX_HUB_E2E_ENV_FILE: "/tmp/e2e.json" });
    expect(removed.sort()).toEqual(["GATE_INJECT_KEY", "TMUX_HUB_HOST", "TMUX_HUB_SUGGEST", "TMUX_HUB_VOICE_DB_PATH"]);
  });
});
