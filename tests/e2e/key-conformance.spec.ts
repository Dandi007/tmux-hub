import { test, expect } from "./fixtures";
import { bindSecret, uniqSession } from "./helpers";

test.describe("key conformance (desktop xterm.onData path)", () => {
  test("plain text + Enter via desktop xterm flows to pane", async ({ page, ctx }) => {
    const name = uniqSession("shell");
    ctx.tmuxE2E(["new-session", "-d", "-s", name, "sh"]);

    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    await page.locator(".session-list__item", { hasText: name }).click();
    await expect(page.locator(".session-host")).toBeVisible({ timeout: 10_000 });
    await page.locator(".session-host").click();
    // Wait for xterm + WS to fully initialize and consume initial replay
    await page.waitForTimeout(1500);

    await page.keyboard.type("echo KEY_CONFORMANCE_OK");
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);

    const captured = ctx.tmuxE2E(["capture-pane", "-p", "-t", name]);
    expect(captured).toContain("KEY_CONFORMANCE_OK");

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("Backspace deletes characters", async ({ page, ctx }) => {
    const name = uniqSession("shell");
    ctx.tmuxE2E(["new-session", "-d", "-s", name, "sh"]);

    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    await page.locator(".session-list__item", { hasText: name }).click();
    await expect(page.locator(".session-host")).toBeVisible({ timeout: 10_000 });
    await page.locator(".session-host").click();
    await page.waitForTimeout(1500);

    await page.keyboard.type("echo BAD");
    await page.waitForTimeout(200);
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(200);
    await page.keyboard.type("OK_AFTER_BS");
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);

    const captured = ctx.tmuxE2E(["capture-pane", "-p", "-t", name]);
    expect(captured).toContain("OK_AFTER_BS");
    expect(captured).not.toContain("BAD");

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("Ctrl-C interrupts a running command", async ({ page, ctx }) => {
    const name = uniqSession("shell");
    ctx.tmuxE2E(["new-session", "-d", "-s", name, "sh"]);

    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    await page.locator(".session-list__item", { hasText: name }).click();
    await expect(page.locator(".session-host")).toBeVisible({ timeout: 10_000 });
    await page.locator(".session-host").click();
    await page.waitForTimeout(1500);

    // Avoid putting any test-marker substring in the COMMAND text itself, so
    // the only way it appears in the captured pane is via stdout (which proves
    // the command ran — i.e. Ctrl-C failed).
    await page.keyboard.type("sleep 10 && echo SHOULD_NOT_PRINT");
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    await page.keyboard.press("Control+c");
    await page.waitForTimeout(700);
    await page.keyboard.type("echo AFTER_CTRL_C");
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);

    const captured = ctx.tmuxE2E(["capture-pane", "-p", "-t", name]);
    expect(captured).toContain("AFTER_CTRL_C");
    // SHOULD_NOT_PRINT appears once in the prompt line (typed command); if Ctrl-C
    // failed it would also appear as an echoed stdout line. Require exactly 1 hit.
    const occurrences = (captured.match(/SHOULD_NOT_PRINT/g) ?? []).length;
    expect(occurrences).toBe(1);

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });
});
