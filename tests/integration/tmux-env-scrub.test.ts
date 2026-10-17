import { describe, test, expect, afterAll } from "bun:test";
import { tmuxTest, tmuxTestKillServer, setupIsolatedTmux } from "../helpers/tmux-test";
import { tmux } from "../../src/server/tmux-cmd";
import { bootstrapTmuxHooks } from "../../src/server/tmux-bootstrap";

async function isolatedRunner(args: string[]): Promise<string> {
  const r = await tmuxTest(args);
  if (r.code !== 0) throw new Error(`tmux ${args.join(" ")} failed (${r.code}): ${r.stderr}`);
  return r.stdout;
}

const S = "envscrub-" + Date.now().toString().slice(-8);

afterAll(async () => {
  await tmuxTestKillServer();
});

describe("hub-private env never reaches the tmux server", () => {
  test("a tmux server started by tmux() has no hub credentials in its global env", async () => {
    const { socket } = setupIsolatedTmux();
    const saved = { ...process.env };
    process.env.GATE_INJECT_KEY = "leak-gate";
    process.env.TMUX_HUB_SUGGEST_TOKEN = "leak-token";
    try {
      const r = await tmux(["-L", socket, "new-session", "-d", "-s", S, "sleep 30"]);
      expect(r.code).toBe(0);
    } finally {
      for (const k of ["GATE_INJECT_KEY", "TMUX_HUB_SUGGEST_TOKEN"]) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    }
    const out = await isolatedRunner(["show-environment", "-g"]);
    expect(out).not.toContain("leak-gate");
    expect(out).not.toContain("leak-token");
    expect(out).toContain("PATH=");
  });

  test("bootstrap scrubs hub-private keys an older hub already leaked", async () => {
    await isolatedRunner(["set-environment", "-g", "GATE_INJECT_KEY", "old-leak"]);
    await isolatedRunner(["set-environment", "-g", "TMUX_HUB_UPLOAD_BROKER_TOKEN", "old-leak2"]);
    await isolatedRunner(["set-environment", "-g", "TMUX_HUB_PORT", "3102"]);
    await bootstrapTmuxHooks(isolatedRunner);
    const out = await isolatedRunner(["show-environment", "-g"]);
    expect(out).not.toContain("old-leak");
    expect(out).toContain("TMUX_HUB_PORT=3102");
    // Idempotent on an already-clean server.
    await bootstrapTmuxHooks(isolatedRunner);
  });
});
