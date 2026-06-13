import { test, expect } from "bun:test";

test("EMULATOR_ENABLED reflects TMUX_HUB_EMULATOR=1", async () => {
  process.env.TMUX_HUB_EMULATOR = "1";
  // Query suffix forces Bun to load a fresh module instance (env-isolated).
  // TypeScript doesn't know about query-string imports; suppress the error.
  // @ts-ignore
  const mod = await import("../../src/server/config?emu-on");
  expect(mod.EMULATOR_ENABLED).toBe(true);
});

test("SNAPSHOT_SCROLLBACK_LINES defaults to 1000", async () => {
  delete process.env.TMUX_HUB_SNAPSHOT_SCROLLBACK_LINES;
  // @ts-ignore
  const mod = await import("../../src/server/config?emu-default");
  expect(mod.SNAPSHOT_SCROLLBACK_LINES).toBe(1000);
});
