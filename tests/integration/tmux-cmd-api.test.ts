// Validate the src/server/tmux-cmd.ts API compiles + works through the same subprocess machinery.
// Production tmux-cmd uses the user's default socket; in tests we pass explicit -L <socket> args
// to redirect every call into the isolated tmux server set up by setupIsolatedTmux().
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupIsolatedTmux, tmuxTestKillServer } from "../helpers/tmux-test";

let tmuxApi: typeof import("../../src/server/tmux-cmd");
let socket: string;

beforeAll(async () => {
  const { socket: s } = setupIsolatedTmux();
  socket = s;
  tmuxApi = await import("../../src/server/tmux-cmd");
});

afterAll(async () => {
  await tmuxTestKillServer();
});

describe("tmux-cmd API surface", () => {
  test("tmux() returns ok result for -V on isolated socket", async () => {
    // We test the API surface indirectly: call tmux() with -L to force isolated socket
    const r = await tmuxApi.tmux(["-L", socket, "-V"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^tmux \d/);
    expect(r.stderr).toBe("");
  });

  test("tmuxOk() throws on nonzero exit", async () => {
    await expect(
      tmuxApi.tmuxOk(["-L", socket, "display", "-p", "-t", "no-such-session", "x"]),
    ).rejects.toThrow(/failed/);
  });
});
