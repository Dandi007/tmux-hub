import { describe, test, expect } from "bun:test";
import { socketArgs, withSocket } from "../../src/server/tmux-cmd";

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

describe("withSocket", () => {
  const capture = ["capture-pane", "-p", "-t", "s:0.0", "-S", "-1000"];

  test("subcommand -S (start line) still gets the hub socket prepended", () => {
    expect(withSocket(capture, { TMUX_HUB_SOCKET: "hub-dogfood" }))
      .toEqual(["-L", "hub-dogfood", ...capture]);
    expect(withSocket(capture, { TMUX_HUB_SOCKET_PATH: "/run/s" }))
      .toEqual(["-S", "/run/s", ...capture]);
  });

  test("leading global -L/-S is left alone", () => {
    const args = ["-L", "other", "list-sessions"];
    expect(withSocket(args, { TMUX_HUB_SOCKET: "hub-dogfood" })).toEqual(args);
  });
});
