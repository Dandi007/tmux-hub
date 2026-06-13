import { test, expect } from "./fixtures";
import { bindSecret } from "./helpers";
import type { Page, Locator } from "@playwright/test";

// Conformance of the desktop xterm.onData keystroke path: real typing into the
// focused terminal must flow through the WS to the pane. Sessions are managed
// (ctx.createSession), selected via the tab-bar, then driven by the keyboard.

function tab(page: Page, name: string): Locator {
  return page.locator(`.tab-bar__tab[data-session="${name}"]`);
}

async function openAndFocus(page: Page, name: string): Promise<void> {
  await page.goto("/");
  await bindSecret(page);
  await page.reload();

  await expect(tab(page, name)).toBeVisible({ timeout: 10_000 });
  await tab(page, name).click();
  await expect(page.locator(".desktop-shell__term-host")).toBeVisible({ timeout: 10_000 });
  await page.locator(".desktop-shell__term-host").click();
  // Let xterm + WS finish init and consume the initial replay before typing.
  await page.waitForTimeout(1500);
}

test.describe("key conformance (desktop xterm.onData path)", () => {
  test("plain text + Enter flows to the pane", async ({ page, ctx }) => {
    const name = await ctx.createSession("kb-cc"); // plain sh — deterministic echo, no zsh ghost
    await openAndFocus(page, name);

    await page.keyboard.type("echo KEY_CONFORMANCE_OK");
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);

    const captured = ctx.tmuxE2E(["capture-pane", "-p", "-t", name]);
    expect(captured).toContain("KEY_CONFORMANCE_OK");

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("Backspace deletes characters", async ({ page, ctx }) => {
    const name = await ctx.createSession("kb-cc"); // plain sh — deterministic echo, no zsh ghost
    await openAndFocus(page, name);

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
    const name = await ctx.createSession("kb-cc"); // plain sh — deterministic echo, no zsh ghost
    await openAndFocus(page, name);

    // Keep the test-marker substring OUT of the command text itself, so the
    // only way it appears in the captured pane is via stdout (i.e. Ctrl-C
    // failed and the command actually ran).
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
    // SHOULD_NOT_PRINT appears once in the typed command line; a second
    // occurrence as echoed stdout would mean Ctrl-C did not interrupt.
    const occurrences = (captured.match(/SHOULD_NOT_PRINT/g) ?? []).length;
    expect(occurrences).toBe(1);

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });
});
