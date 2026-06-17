import { join } from "node:path";
import { test, expect } from "./fixtures";
import { bindSecret } from "./helpers";
import type { Page, Locator } from "@playwright/test";

// Mobile shell: a session-picker dropdown in the header + a bottom input bar
// (inline-expand textarea) + a collapsible special-keys panel. Sessions are
// created through the hub's managed path (ctx.createSession / quick-launch),
// never side-loaded — the registry only surfaces managed sessions.

function pickerItem(page: Page, name: string): Locator {
  return page.locator(`.session-picker__item[data-session="${name}"]`);
}

async function openApp(page: Page): Promise<void> {
  await page.goto("/");
  await bindSecret(page);
  await page.reload();
}

async function selectSession(page: Page, name: string): Promise<void> {
  await expect(pickerItem(page, name)).toHaveCount(1, { timeout: 10_000 });
  await page.locator(".session-picker__trigger").click();
  await pickerItem(page, name).click();
  await page.waitForTimeout(800);
}

/** Type into the bottom input bar and send (literal + Enter). */
async function sendText(page: Page, text: string): Promise<void> {
  const ta = page.locator(".input-bar__textarea");
  await ta.click(); // focus → input bar enters editing mode, right button = 发送
  if (text) await ta.fill(text);
  await page.locator(".input-bar__send").click();
}

test.describe("mobile view", () => {
  test("input bar submit reaches the pane", async ({ page, ctx }) => {
    const name = await ctx.createSession("kb-cc"); // plain sh — deterministic echo

    await openApp(page);
    await selectSession(page, name);
    await page.waitForTimeout(1000);

    await sendText(page, "echo MOBILE_E2E_OK");

    await page.waitForTimeout(1000);
    const captured = ctx.tmuxE2E(["capture-pane", "-p", "-t", name]);
    expect(captured).toContain("MOBILE_E2E_OK");

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("special-keys panel ^C interrupts a running command", async ({ page, ctx }) => {
    const name = await ctx.createSession("kb-cc");

    await openApp(page);
    await selectSession(page, name);
    await page.waitForTimeout(1000);

    // Keep marker out of the command text so it only appears via stdout if ^C fails.
    await sendText(page, "sleep 5 && echo SHOULD_NOT_PRINT");
    await page.waitForTimeout(500);

    // Open the keys panel (the + / expand button) and tap ^C.
    await page.locator(".input-bar__expand").click();
    await expect(page.locator(".mobile-keys-panel")).toHaveClass(/is-open/, { timeout: 5_000 });
    await page.locator(".special-keys button", { hasText: "^C" }).click({ force: true });
    await page.waitForTimeout(700);

    const captured = ctx.tmuxE2E(["capture-pane", "-p", "-t", name]);
    const occurrences = (captured.match(/SHOULD_NOT_PRINT/g) ?? []).length;
    expect(occurrences).toBe(1);

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("quick-launch button starts a kb-cc session and switches to it", async ({ page, ctx }) => {
    await openApp(page);

    const btn = page.getByRole("button", { name: "新建知识库 Claude Code 会话" });
    await expect(btn).toBeVisible({ timeout: 10_000 });
    await expect(btn).toBeEnabled({ timeout: 10_000 });
    await btn.click();

    let names: string[] = [];
    for (let i = 0; i < 40; i++) {
      names = ctx.tmuxE2E(["list-sessions", "-F", "#{session_name}"]).split("\n").filter(Boolean);
      if (names.some((n) => n.startsWith("kb-cc-"))) break;
      await page.waitForTimeout(200);
    }
    const newName = names.find((n) => n.startsWith("kb-cc-"));
    expect(newName, `expected a kb-cc-* session in ${JSON.stringify(names)}`).toBeTruthy();

    await expect(pickerItem(page, newName!)).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator(".session-picker__name")).toHaveText(newName!, { timeout: 10_000 });

    ctx.tmuxE2E(["kill-session", "-t", newName!]);
  });

  test("empty input bar submit sends a bare Enter to the pane", async ({ page, ctx }) => {
    const name = await ctx.createSession("kb-cc");

    await openApp(page);
    await selectSession(page, name);
    await page.waitForTimeout(1000);

    // Empty textarea → send → bare Enter → a fresh prompt line appears. Count
    // `$` since sh emits `sh-3.2$` (no trailing space); ≥2 prompts proves the
    // Enter reached the pane.
    await sendText(page, "");
    await page.waitForTimeout(700);

    const captured = ctx.tmuxE2E(["capture-pane", "-p", "-t", name]);
    const promptOccurrences = (captured.match(/\$/g) ?? []).length;
    expect(promptOccurrences).toBeGreaterThanOrEqual(2);

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("rename button switches header to edit-mode and renames the session", async ({ page, ctx }) => {
    const name = await ctx.createSession();
    const renamed = `${name}-r`;

    await openApp(page);
    await selectSession(page, name);

    await page.getByRole("button", { name: "重命名当前 session" }).click();
    const input = page.locator(".mobile-shell__rename-input");
    await expect(input).toBeVisible();
    await expect(input).toHaveValue(name);

    await input.fill(renamed);
    await page.locator(".mobile-shell__rename-save").click();

    await expect(pickerItem(page, renamed)).toHaveCount(1, { timeout: 5_000 });
    await expect(page.locator(".session-picker__name")).toHaveText(renamed);

    try { ctx.tmuxE2E(["kill-session", "-t", renamed]); } catch { /* renamed away */ }
  });

  test("rename cancel restores the picker without firing a request", async ({ page, ctx }) => {
    const name = await ctx.createSession();

    await openApp(page);
    await selectSession(page, name);

    await page.getByRole("button", { name: "重命名当前 session" }).click();
    await page.locator(".mobile-shell__rename-input").fill("ignored-value");
    await page.locator(".mobile-shell__rename-cancel").click();

    await expect(page.locator(".session-picker__trigger")).toBeVisible();
    await expect(page.locator(".session-picker__name")).toHaveText(name);

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("kill button shows confirm modal — cancel keeps the session alive", async ({ page, ctx }) => {
    const name = await ctx.createSession();

    await openApp(page);
    await selectSession(page, name);

    await page.getByRole("button", { name: "关闭当前 session" }).click();
    await expect(page.locator(".modal-dialog")).toBeVisible();
    await expect(page.locator(".modal-dialog__title")).toHaveText("关闭会话");

    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.locator(".modal-dialog")).not.toBeVisible();

    expect(ctx.tmuxE2E(["list-sessions", "-F", "#{session_name}"]).split("\n")).toContain(name);

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("kill button confirm destroys the session and switches to the survivor", async ({ page, ctx }) => {
    const keep = await ctx.createSession();
    const kill = await ctx.createSession();

    await openApp(page);
    await selectSession(page, kill);

    await page.getByRole("button", { name: "关闭当前 session" }).click();
    await expect(page.locator(".modal-dialog")).toBeVisible();
    await page.locator(".modal-dialog__actions button.is-danger").click();

    await expect(pickerItem(page, kill)).toHaveCount(0, { timeout: 10_000 });
    const sessions = ctx.tmuxE2E(["list-sessions", "-F", "#{session_name}"]).split("\n");
    expect(sessions).not.toContain(kill);
    expect(sessions).toContain(keep);
    await expect(page.locator(".session-picker__name")).toHaveText(keep, { timeout: 10_000 });

    ctx.tmuxE2E(["kill-session", "-t", keep]);
  });

  test("image attach: upload opens editing and drops the path into the textarea", async ({ page, ctx }) => {
    const name = await ctx.createSession();

    await openApp(page);
    await selectSession(page, name);

    const hiddenInput = page.locator(".mobile-toolbar__image-attach-input");
    const fixturePath = join(process.cwd(), "tests/e2e/fixtures/red.png");
    await hiddenInput.setInputFiles(fixturePath);

    await expect(page.locator(".mobile-input-bar")).toHaveClass(/is-editing/, { timeout: 5_000 });
    const ta = page.locator(".input-bar__textarea");
    await expect(ta).toHaveValue(/\.png\s*$/, { timeout: 5_000 });

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("image attach: multi-select uploads every file and drops all paths", async ({ page, ctx }) => {
    const name = await ctx.createSession();

    await openApp(page);
    await selectSession(page, name);

    const hiddenInput = page.locator(".mobile-toolbar__image-attach-input");
    await hiddenInput.setInputFiles([
      join(process.cwd(), "tests/e2e/fixtures/red.png"),
      join(process.cwd(), "tests/e2e/fixtures/blue.png"),
    ]);

    await expect(page.locator(".mobile-input-bar")).toHaveClass(/is-editing/, { timeout: 5_000 });
    const ta = page.locator(".input-bar__textarea");
    // Both files land as distinct UUID-named paths → two .png tokens in order.
    await expect
      .poll(async () => ((await ta.inputValue()).match(/\.png(?=\s)/g) ?? []).length, {
        timeout: 5_000,
      })
      .toBe(2);

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("switching sessions reattaches the selected session", async ({ page, ctx }) => {
    const a = await ctx.createSession("kb-cc");
    const b = await ctx.createSession("kb-cc");
    ctx.tmuxE2E(["send-keys", "-t", a, "echo ALPHA_MOBILE_MARK", "Enter"]);
    ctx.tmuxE2E(["send-keys", "-t", b, "echo BETA_MOBILE_MARK", "Enter"]);

    await openApp(page);

    await selectSession(page, a);
    await expect(page.locator(".session-picker__name")).toHaveText(a);
    expect(ctx.tmuxE2E(["capture-pane", "-p", "-t", a])).toContain("ALPHA_MOBILE_MARK");

    await selectSession(page, b);
    await expect(page.locator(".session-picker__name")).toHaveText(b);
    expect(ctx.tmuxE2E(["capture-pane", "-p", "-t", b])).toContain("BETA_MOBILE_MARK");

    ctx.tmuxE2E(["kill-session", "-t", a]);
    ctx.tmuxE2E(["kill-session", "-t", b]);
  });

  test("session picker opens and closes on trigger click", async ({ page, ctx }) => {
    const name = await ctx.createSession();

    await openApp(page);
    await expect(pickerItem(page, name)).toHaveCount(1, { timeout: 10_000 });

    const picker = page.locator(".session-picker");
    await expect(picker).not.toHaveClass(/is-open/);

    await page.locator(".session-picker__trigger").click();
    await expect(picker).toHaveClass(/is-open/);

    await page.locator(".session-picker__backdrop").click({ force: true });
    await expect(picker).not.toHaveClass(/is-open/);

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("input bar enters and leaves editing mode", async ({ page, ctx }) => {
    const name = await ctx.createSession();

    await openApp(page);
    await selectSession(page, name);

    const inputBar = page.locator(".mobile-input-bar");
    await expect(inputBar).not.toHaveClass(/is-editing/);

    await page.locator(".input-bar__textarea").click();
    await expect(inputBar).toHaveClass(/is-editing/);

    await page.locator(".input-bar__send").click();
    await expect(inputBar).not.toHaveClass(/is-editing/);

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("arrow keys from the special-keys panel reach the pane", async ({ page, ctx }) => {
    const name = await ctx.createSession("kb-cc");

    await openApp(page);
    await selectSession(page, name);
    await page.waitForTimeout(1000);

    await sendText(page, "echo ARROW_TEST");
    await page.waitForTimeout(500);

    // Open keys panel, recall the last command with ↑, run it with ↵.
    await page.locator(".input-bar__expand").click();
    await expect(page.locator(".mobile-keys-panel")).toHaveClass(/is-open/, { timeout: 5_000 });
    await page.locator(".tk-up").click({ force: true });
    await page.waitForTimeout(300);
    await page.locator(".tk-enter").click({ force: true });
    await page.waitForTimeout(1000);

    const captured = ctx.tmuxE2E(["capture-pane", "-p", "-t", name]);
    const occurrences = (captured.match(/ARROW_TEST/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("a managed session created after load appears in the picker via SSE", async ({ page, ctx }) => {
    await openApp(page);
    await page.waitForTimeout(500);

    const name = await ctx.createSession();
    await expect(pickerItem(page, name)).toHaveCount(1, { timeout: 10_000 });

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("an unmanaged tmux session never appears in the picker (managed-only filter)", async ({ page, ctx }) => {
    await openApp(page);
    await page.waitForTimeout(500);

    const external = `ext-${Date.now().toString().slice(-12)}`;
    ctx.tmuxE2E(["new-session", "-d", "-s", external, "sh"]);

    await page.waitForTimeout(3_000);
    await expect(pickerItem(page, external)).toHaveCount(0);

    ctx.tmuxE2E(["kill-session", "-t", external]);
  });

  test("a session killed externally disappears from the picker via SSE", async ({ page, ctx }) => {
    const name = await ctx.createSession();

    await openApp(page);
    await expect(pickerItem(page, name)).toHaveCount(1, { timeout: 10_000 });

    ctx.tmuxE2E(["kill-session", "-t", name]);

    await expect(pickerItem(page, name)).toHaveCount(0, { timeout: 10_000 });
  });
});
