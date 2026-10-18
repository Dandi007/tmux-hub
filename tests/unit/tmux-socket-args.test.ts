import { describe, test, expect } from "bun:test";
import { socketArgs } from "../../src/server/tmux-cmd";

describe("socketArgs", () => {
  test("no socket env → default server", () => {
    expect(socketArgs({})).toEqual([]);
  });

  test("TMUX_HUB_SOCKET → -L <name>", () => {
    expect(socketArgs({ TMUX_HUB_SOCKET: "hub-dogfood" })).toEqual(["-L", "hub-dogfood"]);
  });

  test("TMUX_HUB_SOCKET_PATH → -S <path>", () => {
    expect(socketArgs({ TMUX_HUB_SOCKET_PATH: "/run/tmux-sandbox/default" }))
      .toEqual(["-S", "/run/tmux-sandbox/default"]);
  });

  test("both set → throws", () => {
    expect(() => socketArgs({ TMUX_HUB_SOCKET: "a", TMUX_HUB_SOCKET_PATH: "/b" }))
      .toThrow(/mutually exclusive/);
  });
});
