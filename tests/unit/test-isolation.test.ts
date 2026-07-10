// tests/unit/test-isolation.test.ts
// Smoke-checks that the global preload (tests/helpers/preload.ts) actually
// isolated every prod-state knob for this test run. If any of these fail,
// the whole suite is unsafe to run on a production host.
import { describe, test, expect } from "bun:test";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { managedDbPath } from "../../src/server/managed-db";

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
});
