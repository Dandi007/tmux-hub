import { join } from "node:path";
import { test, expect } from "./fixtures";
import { bindSecret, uniqSession } from "./helpers";
import type { Page } from "@playwright/test";

async function openSidebar(page: Page): Promise<void> {
  await page.locator(".desktop-shell__sidebar-toggle").click();
  await page.waitForTimeout(300);
}

async function selectSessionViaSidebar(page: Page, name: string): Promise<void> {
  await openSidebar(page);
  await page.locator(`.session-list__item[data-session-name="${name}"]`).click();
  // sidebar auto-closes on select
}

test.describe("desktop view", () => {
  test("dashboard renders session list and attaches terminal", async ({ page, ctx }) => {
    const name = uniqSession("shell");
    ctx.tmuxE2E(["new-session", "-d", "-s", name, "sh"]);

    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    await openSidebar(page);
    await expect(page.locator(`.session-list__item[data-session-name="${name}"]`))
      .toBeVisible({ timeout: 10_000 });
    await page.locator(`.session-list__item[data-session-name="${name}"]`).click();
    await expect(page.locator(".session-picker__name")).toHaveText(name, { timeout: 5_000 });
    await expect(page.locator(".desktop-shell__term-host")).toBeVisible();

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("kill button requires confirm modal — cancel keeps session alive", async ({ page, ctx }) => {
    const name = uniqSession("shell");
    ctx.tmuxE2E(["new-session", "-d", "-s", name, "sleep 60"]);

    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    await selectSessionViaSidebar(page, name);
    await page.locator(".session-picker__kill").click();

    await page.getByRole("button", { name: "取消", exact: true }).click();

    expect(ctx.tmuxE2E(["list-sessions", "-F", "#{session_name}"]).split("\n")).toContain(name);

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("desktop image attach: toolbar button → upload → path injected to pane", async ({ page, ctx }) => {
    const name = uniqSession("shell");
    ctx.tmuxE2E(["new-session", "-d", "-s", name, "-x", "120", "-y", "40", "sh"]);

    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    await selectSessionViaSidebar(page, name);
    await page.waitForTimeout(800);

    const fixturePath = join(process.cwd(), "tests/e2e/fixtures/red.png");
    await page.locator("input.mobile-toolbar__image-attach-input").setInputFiles(fixturePath);

    // Give upload + send-keys round-trip time
    await page.waitForTimeout(800);
    const captured = ctx.tmuxE2E(["capture-pane", "-p", "-t", name]);
    expect(captured).toMatch(/[\/\w-]+\.png/);

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("kill confirm destroys session and removes from sidebar", async ({ page, ctx }) => {
    const keep = uniqSession("keep");
    const kill = uniqSession("kill");
    ctx.tmuxE2E(["new-session", "-d", "-s", keep, "sh"]);
    ctx.tmuxE2E(["new-session", "-d", "-s", kill, "sleep 60"]);

    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    await selectSessionViaSidebar(page, kill);
    await page.locator(".session-picker__kill").click();
    await expect(page.locator(".modal-dialog")).toBeVisible();
    await page.locator(".modal-dialog__actions button.is-danger").click();

    await openSidebar(page);
    await expect(page.locator(`.session-list__item[data-session-name="${kill}"]`))
      .toHaveCount(0, { timeout: 10_000 });
    const sessions = ctx.tmuxE2E(["list-sessions", "-F", "#{session_name}"]).split("\n");
    expect(sessions).not.toContain(kill);
    expect(sessions).toContain(keep);

    ctx.tmuxE2E(["kill-session", "-t", keep]);
  });

  test("rename inline edit commits on Enter", async ({ page, ctx }) => {
    const name = uniqSession("shell");
    const renamed = `${name}-r`;
    ctx.tmuxE2E(["new-session", "-d", "-s", name, "sh"]);

    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    await openSidebar(page);
    await expect(page.locator(`.session-list__item[data-session-name="${name}"]`))
      .toBeVisible({ timeout: 10_000 });
    await page.locator(`.session-list__item[data-session-name="${name}"] .session-list__rename`).click();

    const input = page.locator(".session-list__input");
    await expect(input).toBeVisible();
    await input.fill(renamed);
    await input.press("Enter");

    await expect(page.locator(`.session-list__item[data-session-name="${renamed}"]`))
      .toBeVisible({ timeout: 10_000 });

    try { ctx.tmuxE2E(["kill-session", "-t", renamed]); } catch {}
  });

  test("rename inline edit cancels on Escape", async ({ page, ctx }) => {
    const name = uniqSession("shell");
    ctx.tmuxE2E(["new-session", "-d", "-s", name, "sh"]);

    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    await openSidebar(page);
    await expect(page.locator(`.session-list__item[data-session-name="${name}"]`))
      .toBeVisible({ timeout: 10_000 });
    await page.locator(`.session-list__item[data-session-name="${name}"] .session-list__rename`).click();

    const input = page.locator(".session-list__input");
    await expect(input).toBeVisible();
    await input.fill("ignored-value");
    await input.press("Escape");

    await expect(input).not.toBeVisible();
    await expect(page.locator(`.session-list__item[data-session-name="${name}"]`))
      .toBeVisible();

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("switching sessions updates header name", async ({ page, ctx }) => {
    const a = uniqSession("alpha");
    const b = uniqSession("beta");
    ctx.tmuxE2E(["new-session", "-d", "-s", a, "sh"]);
    ctx.tmuxE2E(["new-session", "-d", "-s", b, "sh"]);

    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    await selectSessionViaSidebar(page, a);
    await expect(page.locator(".session-picker__name")).toHaveText(a, { timeout: 5_000 });

    await selectSessionViaSidebar(page, b);
    await expect(page.locator(".session-picker__name")).toHaveText(b, { timeout: 5_000 });

    ctx.tmuxE2E(["kill-session", "-t", a]);
    ctx.tmuxE2E(["kill-session", "-t", b]);
  });

  test("template drawer launches a new session", async ({ page, ctx }) => {
    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    await openSidebar(page);
    const drawer = page.locator(".template-drawer");
    await expect(drawer).toBeVisible({ timeout: 10_000 });
    const shellBtn = drawer.locator(".template-drawer__btn").first();
    await expect(shellBtn).toBeVisible();
    await shellBtn.click();

    let names: string[] = [];
    for (let i = 0; i < 30; i++) {
      names = ctx.tmuxE2E(["list-sessions", "-F", "#{session_name}"]).split("\n").filter(Boolean);
      if (names.some((n) => n.startsWith("shell-"))) break;
      await page.waitForTimeout(200);
    }
    const newName = names.find((n) => n.startsWith("shell-"));
    expect(newName).toBeTruthy();

    await openSidebar(page);
    await expect(page.locator(`.session-list__item[data-session-name="${newName!}"]`))
      .toBeVisible({ timeout: 10_000 });

    ctx.tmuxE2E(["kill-session", "-t", newName!]);
  });

  test("session created externally appears in sidebar via SSE", async ({ page, ctx }) => {
    await page.goto("/");
    await bindSecret(page);
    await page.reload();
    await page.waitForTimeout(1000);

    const name = uniqSession("late");
    ctx.tmuxE2E(["new-session", "-d", "-s", name, "sh"]);

    await openSidebar(page);
    await expect(page.locator(`.session-list__item[data-session-name="${name}"]`))
      .toBeVisible({ timeout: 10_000 });

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("session killed externally disappears from sidebar via SSE", async ({ page, ctx }) => {
    const name = uniqSession("ephemeral");
    ctx.tmuxE2E(["new-session", "-d", "-s", name, "sh"]);

    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    await openSidebar(page);
    await expect(page.locator(`.session-list__item[data-session-name="${name}"]`))
      .toBeVisible({ timeout: 10_000 });

    ctx.tmuxE2E(["kill-session", "-t", name]);

    await expect(page.locator(`.session-list__item[data-session-name="${name}"]`))
      .toHaveCount(0, { timeout: 10_000 });
  });

  test("desktop clipboard paste: image item intercepted + path injected", async ({ page, ctx }) => {
    const name = uniqSession("shell");
    ctx.tmuxE2E(["new-session", "-d", "-s", name, "-x", "120", "-y", "40", "sh"]);

    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    await selectSessionViaSidebar(page, name);
    await page.waitForTimeout(800);

    // Synthesize a paste event with an image item on the root desktop-shell element.
    const RED_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
    await page.evaluate((b64: string) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], "clip.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      document.querySelector(".desktop-shell")!.dispatchEvent(ev);
    }, RED_PNG_B64);

    await page.waitForTimeout(800);
    const captured = ctx.tmuxE2E(["capture-pane", "-p", "-t", name]);
    expect(captured).toMatch(/[\/\w-]+\.png/);

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });
});
