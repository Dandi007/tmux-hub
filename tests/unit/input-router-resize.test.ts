import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TMUX_HUB_LOG_DIR = mkdtempSync(join(tmpdir(), "input-resize-"));
const { HubError, InputRouter } = await import("../../src/server/input-router");

test("a rejected tmux resize reports failure instead of an unapplied viewport", async () => {
  let fail = true;
  const router = new InputRouter(async (args) => {
    if (args[0] === "display-message") return { stdout: "0", stderr: "", code: 0 };
    return fail ? { stdout: "", stderr: "resize denied", code: 1 } : { stdout: "", stderr: "", code: 0 };
  });
  await expect(router.send("test", { kind: "resize", cols: 120, rows: 40 })).rejects.toThrow("resize-window failed");
  fail = false;
  expect(await router.send("test", { kind: "resize", cols: 150, rows: 50 })).toEqual({ cols: 150, rows: 50 });
});

test("a session removed during resize retains the session-gone error code", async () => {
  const router = new InputRouter(async (args) => args[0] === "display-message"
    ? { stdout: "0", stderr: "", code: 0 }
    : { stdout: "", stderr: "can't find session: test", code: 1 });
  try {
    await router.send("test", { kind: "resize", cols: 120, rows: 40 });
    throw new Error("resize unexpectedly succeeded");
  } catch (e) {
    expect(e).toBeInstanceOf(HubError);
    expect((e as InstanceType<typeof HubError>).code).toBe(410);
  }
});
