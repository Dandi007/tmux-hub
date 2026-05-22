// tests/integration/tmux-cmd.test.ts
import { describe, test, expect, afterAll } from "bun:test";
import { tmuxTest, tmuxTestKillServer } from "../helpers/tmux-test";

const TEST_SESSION = "tmux-hub-test-" + Date.now();

afterAll(async () => {
  await tmuxTest(["kill-session", "-t", TEST_SESSION]).catch(() => {});
  await tmuxTestKillServer();
});

describe("tmux subprocess wrapper", () => {
  test("returns stdout and exit 0 for tmux -V", async () => {
    // Use tmuxTest so we never touch the default socket; -V is server-agnostic so it works fine
    const { stdout, code } = await tmuxTest(["-V"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^tmux \d/);
  });

  test("returns nonzero code for missing session", async () => {
    const { code, stderr } = await tmuxTest(["display", "-p", "-t", "does-not-exist", "x"]);
    expect(code).not.toBe(0);
    expect(stderr.toLowerCase()).toMatch(/can't find|no server|no session|no such/);
  });

  test("creates a session and lists it on isolated socket", async () => {
    const create = await tmuxTest(["new-session", "-d", "-s", TEST_SESSION, "sleep 30"]);
    expect(create.code).toBe(0);
    const list = await tmuxTest(["list-sessions", "-F", "#{session_name}"]);
    expect(list.code).toBe(0);
    expect(list.stdout.split("\n")).toContain(TEST_SESSION);
  });
});
