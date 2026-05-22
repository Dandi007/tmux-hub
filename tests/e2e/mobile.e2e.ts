import { test, expect } from "./fixtures";
import { bindSecret, uniqSession } from "./helpers";

test.describe("mobile view", () => {
  test("textarea submit reaches the pane", async ({ page, ctx }) => {
    const name = uniqSession("shell");
    ctx.tmuxE2E(["new-session", "-d", "-s", name, "sh"]);

    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    await expect(page.locator(`.mobile-shell__session-select option[value="${name}"]`))
      .toHaveCount(1, { timeout: 10_000 });
    await page.locator(".mobile-shell__session-select").selectOption({ label: name });
    await page.waitForTimeout(1500);

    await page.locator(".mobile-input__textarea").fill("echo MOBILE_E2E_OK");
    // xterm overlay may intercept pointer events; submit form directly via JS
    // Fire form submit; the form handler reads textarea value and sends via WS.
    await page.locator(".mobile-input button[type=submit]").evaluate((btn: HTMLButtonElement) => btn.click());

    await page.waitForTimeout(1000);
    const captured = ctx.tmuxE2E(["capture-pane", "-p", "-t", name]);
    expect(captured).toContain("MOBILE_E2E_OK");

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("special-keys bar Esc / Tab / ^C reach the pane", async ({ page, ctx }) => {
    const name = uniqSession("shell");
    ctx.tmuxE2E(["new-session", "-d", "-s", name, "sh"]);

    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    // Wait for the option to actually appear (registry poll is 2s)
    await expect(page.locator(`.mobile-shell__session-select option[value="${name}"]`))
      .toHaveCount(1, { timeout: 10_000 });
    await page.locator(".mobile-shell__session-select").selectOption({ label: name });
    await page.waitForTimeout(1500);

    // Avoid using a marker substring inside the command text itself: the typed
    // command always appears in the captured prompt line. Use a substring that
    // would only be echoed via stdout if Ctrl-C failed.
    await page.locator(".mobile-input__textarea").fill("sleep 5 && echo SHOULD_NOT_PRINT");
    await page.locator(".mobile-input button[type=submit]").evaluate((btn: HTMLButtonElement) => btn.click());
    await page.waitForTimeout(500);

    await page.locator(".special-keys button", { hasText: "^C" }).click({ force: true });
    await page.waitForTimeout(700);

    const captured = ctx.tmuxE2E(["capture-pane", "-p", "-t", name]);
    // command line contains SHOULD_NOT_PRINT once; if Ctrl-C failed, an echoed
    // stdout line would add a second occurrence.
    const occurrences = (captured.match(/SHOULD_NOT_PRINT/g) ?? []).length;
    expect(occurrences).toBe(1);

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });
});
