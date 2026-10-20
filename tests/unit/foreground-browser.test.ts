import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withForegroundContext } from "../e2e/foreground-browser";

test("foreground browser initialization failure removes its acquired profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "foreground-init-test-"));
  let entered = false;
  try {
    await expect(withForegroundContext(join(root, "missing", "browser.log"), async () => {
      entered = true;
    }, root)).rejects.toThrow("ENOENT");
    expect(entered).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
