import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { tmuxTest, tmuxTestKillServer } from "../helpers/tmux-test";
import { bootstrapTmuxHooks } from "../../src/server/tmux-bootstrap";

async function isolatedRunner(args: string[]): Promise<string> {
  const r = await tmuxTest(args);
  if (r.code !== 0) {
    throw new Error(`tmux ${args.join(" ")} failed (${r.code}): ${r.stderr}`);
  }
  return r.stdout;
}

const S = "bootstrap-" + Date.now().toString().slice(-8);

beforeAll(async () => {
  await tmuxTest(["new-session", "-d", "-s", S, "sleep 30"]);
});

afterAll(async () => {
  await tmuxTest(["kill-session", "-t", S]).catch(() => {});
  await tmuxTestKillServer();
});

describe("bootstrapTmuxHooks", () => {
  test("installs client-attached and client-resized hooks", async () => {
    await bootstrapTmuxHooks(isolatedRunner);
    const out = await isolatedRunner(["show-hooks", "-g"]);
    expect(out).toContain("client-attached");
    expect(out).toContain("client-resized");
    expect(out).toContain("resize-window -A");
  });

  test("is idempotent", async () => {
    await bootstrapTmuxHooks(isolatedRunner);
    await bootstrapTmuxHooks(isolatedRunner);
    const out = await isolatedRunner(["show-hooks", "-g"]);
    const attachedHits = out.match(/client-attached\[0\]/g) ?? [];
    const resizedHits = out.match(/client-resized\[0\]/g) ?? [];
    expect(attachedHits.length).toBe(1);
    expect(resizedHits.length).toBe(1);
  });
});
