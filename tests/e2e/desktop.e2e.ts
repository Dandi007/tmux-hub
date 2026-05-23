import { join } from "node:path";
import { test, expect } from "./fixtures";
import { bindSecret, uniqSession } from "./helpers";

test.describe("desktop view", () => {
  test("dashboard renders and attaches to a session", async ({ page, ctx }) => {
    const name = uniqSession("shell");
    ctx.tmuxE2E(["new-session", "-d", "-s", name, "sh"]);

    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    await expect(page.locator(".session-list__item", { hasText: name })).toBeVisible({ timeout: 10_000 });
    await page.locator(".session-list__item", { hasText: name }).click();

    ctx.tmuxE2E(["send-keys", "-t", name, "echo DESKTOP_E2E_OK", "Enter"]);
    await expect(page.locator(".session-host")).toContainText("DESKTOP_E2E_OK", { timeout: 10_000 });

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("external session (grammar violation) shown read-only with badge", async ({ page, ctx }) => {
    // tmux replaces "." with "_" in session names. Use a name that survives.
    const badName = "external_thing";
    ctx.tmuxE2E(["new-session", "-d", "-s", badName, "sh"]);

    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    const item = page.locator(".session-list__item.is-external", { hasText: badName });
    await expect(item).toBeVisible({ timeout: 10_000 });
    await expect(item.locator(".badge--external")).toBeVisible();

    ctx.tmuxE2E(["kill-session", "-t", badName]);
  });

  test("kill button requires confirm modal — cancel keeps session alive", async ({ page, ctx }) => {
    const name = uniqSession("shell");
    ctx.tmuxE2E(["new-session", "-d", "-s", name, "sleep 60"]);

    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    await page.locator(".session-list__item", { hasText: name }).click();
    await page.getByRole("button", { name: "kill", exact: true }).click();

    await page.getByRole("button", { name: "取消", exact: true }).click();

    expect(ctx.tmuxE2E(["list-sessions", "-F", "#{session_name}"]).split("\n")).toContain(name);

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("desktop image attach: header button → upload → path injected to pane", async ({ page, ctx }) => {
    const name = uniqSession("shell");
    ctx.tmuxE2E(["new-session", "-d", "-s", name, "-x", "120", "-y", "40", "sh"]);

    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    await page.locator(`.session-list__item[data-session-name="${name}"]`).click();
    await page.waitForTimeout(800);

    const fixturePath = join(process.cwd(), "tests/e2e/fixtures/red.png");
    await page.locator(".session-header__image-attach-input").setInputFiles(fixturePath);

    // Give upload + send-keys round-trip time
    await page.waitForTimeout(800);
    const captured = ctx.tmuxE2E(["capture-pane", "-p", "-t", name]);
    expect(captured).toMatch(/[\/\w-]+\.png/);

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });
});
