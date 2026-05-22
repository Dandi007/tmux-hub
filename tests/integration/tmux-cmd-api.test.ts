// Validate the src/server/tmux-cmd.ts API compiles + works through the same subprocess machinery.
// Production tmux-cmd uses the user's default socket, which is forbidden in test code — so we
// shim by setting TMUX_TMPDIR/etc via the helper to redirect even default-socket calls into the
// isolated namespace before importing the module.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupIsolatedTmux, tmuxTestKillServer } from "../helpers/tmux-test";

let tmuxApi: typeof import("../../src/server/tmux-cmd");
let socket: string;

beforeAll(async () => {
  const { socket: s } = setupIsolatedTmux();
  socket = s;
  // Re-bind the default tmux socket env var so the module's no-flag tmux calls hit the isolated server
  process.env.TMUX_DEFAULT_SOCKET = s; // sentinel for tmux-cmd; see note in src
  tmuxApi = await import("../../src/server/tmux-cmd");
});

afterAll(async () => {
  await tmuxTestKillServer();
});

describe("tmux-cmd API surface", () => {
  test("tmux() returns ok result for -V on isolated socket via helper interop", async () => { // tmux-cmd
    // We test the API surface indirectly: call tmux() with -L to force isolated socket
    const r = await tmuxApi.tmux(["-L", socket, "-V"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^tmux \d/); // tmux-cmd version output
    expect(r.stderr).toBe("");
  });

  test("tmuxOk() throws on nonzero exit", async () => {
    await expect(
      tmuxApi.tmuxOk(["-L", socket, "display", "-p", "-t", "no-such-session", "x"]),
    ).rejects.toThrow(/failed/);
  });
});
