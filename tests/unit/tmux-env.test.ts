import { describe, test, expect } from "bun:test";
import { isHubPrivateEnvKey, tmuxChildEnv } from "../../src/server/tmux-env";

// The tmux server snapshots its spawner's environment into the global env, and
// every session inherits it. The hub runs with hub.env / dogfood.env loaded, so
// anything hub-private must not reach the tmux child (backlog P0, 2026-10-17).
describe("tmuxChildEnv", () => {
  const hubEnv = {
    PATH: "/usr/bin",
    HOME: "/home/u",
    LANG: "en_US.UTF-8",
    TMUX_TMPDIR: "/run/tmux",
    GATE_INJECT_KEY: "k",
    TMUX_HUB_SUGGEST_TOKEN: "t",
    TMUX_HUB_UPLOAD_BROKER_TOKEN: "t2",
    TMUX_HUB_HOST: "100.64.0.6",
    TMUX_HUB_DB_PATH: "/x/db",
    TMUX_HUB_VOICE_DB_PATH: "/x/voice.db",
    TMUX_HUB_SOCKET: "hub-dogfood",
    TMUX_HUB_PORT: "3102",
    TMUX_HUB_SECRET_PATH: "/c/dogfood.secret",
    TMUX_HUB_ADMIN_SECRET_PATH: "/c/admin.secret",
  };

  test("drops credentials and hub-private config", () => {
    const env = tmuxChildEnv(hubEnv);
    for (const k of ["GATE_INJECT_KEY", "TMUX_HUB_SUGGEST_TOKEN", "TMUX_HUB_UPLOAD_BROKER_TOKEN",
      "TMUX_HUB_HOST", "TMUX_HUB_DB_PATH", "TMUX_HUB_VOICE_DB_PATH"]) {
      expect(env[k]).toBeUndefined();
    }
  });

  test("keeps ordinary env, TMUX_TMPDIR and the CLI routing knobs", () => {
    const env = tmuxChildEnv(hubEnv);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/u");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.TMUX_TMPDIR).toBe("/run/tmux");
    // `tmux-hub tui` run inside a session finds its own hub through these.
    expect(env.TMUX_HUB_SOCKET).toBe("hub-dogfood");
    expect(env.TMUX_HUB_PORT).toBe("3102");
    expect(env.TMUX_HUB_SECRET_PATH).toBe("/c/dogfood.secret");
    expect(env.TMUX_HUB_ADMIN_SECRET_PATH).toBe("/c/admin.secret");
  });

  test("drops TMUX so the hub never acts as a nested client", () => {
    expect(tmuxChildEnv({ ...hubEnv, TMUX: "/tmp/x,1,0" }).TMUX).toBeUndefined();
  });

  test("isHubPrivateEnvKey", () => {
    expect(isHubPrivateEnvKey("GATE_INJECT_KEY")).toBe(true);
    expect(isHubPrivateEnvKey("TMUX_HUB_SUGGEST_TOKEN")).toBe(true);
    expect(isHubPrivateEnvKey("TMUX_HUB_PORT")).toBe(false);
    expect(isHubPrivateEnvKey("TMUX_TMPDIR")).toBe(false);
    expect(isHubPrivateEnvKey("PATH")).toBe(false);
  });
});
