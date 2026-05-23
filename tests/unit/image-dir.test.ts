import { describe, test, expect } from "bun:test";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

function readConsts(env: Record<string, string | undefined> = {}): { IMAGE_DIR: string; MAX_IMAGE_BYTES: number } {
  const script = `
    const c = await import("./src/server/config.ts");
    process.stdout.write(JSON.stringify({ IMAGE_DIR: c.IMAGE_DIR, MAX_IMAGE_BYTES: c.MAX_IMAGE_BYTES }));
  `;
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("TMUX_HUB_")) continue;
    if (typeof v === "string") cleanEnv[k] = v;
  }
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) cleanEnv[k] = v;
  }
  const res = spawnSync("bun", ["-e", script], { env: cleanEnv });
  if (res.status !== 0) throw new Error(`bun -e failed: ${res.stderr.toString()}`);
  return JSON.parse(res.stdout.toString());
}

describe("IMAGE_DIR / MAX_IMAGE_BYTES env resolution", () => {
  test("defaults: ~/Pictures/tmux-hub + 20MB", () => {
    const c = readConsts({});
    expect(c.IMAGE_DIR).toBe(`${homedir()}/Pictures/tmux-hub`);
    expect(c.MAX_IMAGE_BYTES).toBe(20 * 1024 * 1024);
  });

  test("respects absolute path override", () => {
    const c = readConsts({ TMUX_HUB_IMAGE_DIR: "/Volumes/Data/tmux-hub-images" });
    expect(c.IMAGE_DIR).toBe("/Volumes/Data/tmux-hub-images");
  });

  test("respects ~/... override (expanded)", () => {
    const c = readConsts({ TMUX_HUB_IMAGE_DIR: "~/custom-img-dir" });
    expect(c.IMAGE_DIR).toBe(`${homedir()}/custom-img-dir`);
  });

  test("respects MAX_IMAGE_BYTES override", () => {
    const c = readConsts({ TMUX_HUB_MAX_IMAGE_BYTES: String(50 * 1024 * 1024) });
    expect(c.MAX_IMAGE_BYTES).toBe(50 * 1024 * 1024);
  });
});
