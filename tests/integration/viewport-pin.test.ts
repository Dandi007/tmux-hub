import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { tmuxTest, tmuxTestKillServer } from "../helpers/tmux-test";
import { pinViewport } from "../../src/server/viewport-pinner";

const S = "user-vp-" + Date.now().toString().slice(-8);

async function isolatedRunner(args: string[]): Promise<string> {
  const r = await tmuxTest(args);
  if (r.code !== 0) {
    throw new Error(`tmux ${args.join(" ")} failed (${r.code}): ${r.stderr}`);
  }
  return r.stdout;
}

beforeAll(async () => {
  await tmuxTest(["new-session", "-d", "-s", S, "sleep 30"]);
});

afterAll(async () => {
  await tmuxTest(["kill-session", "-t", S]).catch(() => {});
  await tmuxTestKillServer();
});

describe("viewport-pinner", () => {
  test("pins window size to 200x50", async () => {
    await pinViewport(S, 200, 50, isolatedRunner);
    const out = await isolatedRunner(["display", "-p", "-t", `${S}:@0`, "#{window_width}x#{window_height}"]);
    expect(out).toBe("200x50");
  });

  test("sets window-size manual", async () => {
    await pinViewport(S, 200, 50, isolatedRunner);
    const out = await isolatedRunner(["show-options", "-t", S, "-w", "window-size"]);
    expect(out).toContain("manual");
  });

  test("custom cols/rows", async () => {
    await pinViewport(S, 120, 30, isolatedRunner);
    const out = await isolatedRunner(["display", "-p", "-t", `${S}:@0`, "#{window_width}x#{window_height}"]);
    expect(out).toBe("120x30");
  });
});
