import { describe, test, expect } from "bun:test";

describe("suggest config 默认值", () => {
  test("未设 env 时 flag 关、有默认 endpoint/行数/超时", async () => {
    // Use subprocess to get a fresh import without env pollution from other tests.
    const proc = Bun.spawn(
      ["bun", "-e", `
        delete process.env.TMUX_HUB_SUGGEST;
        delete process.env.TMUX_HUB_SUGGEST_CAPTURE_LINES;
        delete process.env.TMUX_HUB_SUGGEST_TIMEOUT_MS;
        const m = await import('./src/server/config.ts');
        process.stdout.write(JSON.stringify({
          SUGGEST_ENABLED: m.SUGGEST_ENABLED,
          SUGGEST_ENDPOINT: m.SUGGEST_ENDPOINT,
          SUGGEST_CAPTURE_LINES: m.SUGGEST_CAPTURE_LINES,
          SUGGEST_TIMEOUT_MS: m.SUGGEST_TIMEOUT_MS,
        }));
      `],
      {
        cwd: new URL("../../", import.meta.url).pathname,
        env: { ...process.env, TMUX_HUB_SUGGEST: undefined, TMUX_HUB_SUGGEST_CAPTURE_LINES: undefined, TMUX_HUB_SUGGEST_TIMEOUT_MS: undefined },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const m = JSON.parse(text) as {
      SUGGEST_ENABLED: boolean;
      SUGGEST_ENDPOINT: string;
      SUGGEST_CAPTURE_LINES: number;
      SUGGEST_TIMEOUT_MS: number;
    };
    expect(m.SUGGEST_ENABLED).toBe(false);
    expect(m.SUGGEST_ENDPOINT).toContain("15721");
    expect(m.SUGGEST_CAPTURE_LINES).toBe(40);
    expect(m.SUGGEST_TIMEOUT_MS).toBe(6000);
  });
});
