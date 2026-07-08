import { join } from "node:path";
import { test, expect } from "./fixtures";
import { bindSecret } from "./helpers";
import type { Page, Locator } from "@playwright/test";

// The desktop shell is a tab-bar UI (one tab per managed session). These tests
// drive it the way a user does: sessions are born through the hub's managed
// launch path (ctx.createSession / the + button), never side-loaded as raw
// tmux sessions — the registry only surfaces managed sessions, so a raw
// `tmux new-session` would be invisible and prove nothing.

function tab(page: Page, name: string): Locator {
  return page.locator(`.tab-bar__tab[data-session="${name}"]`);
}

async function openApp(page: Page): Promise<void> {
  await page.goto("/");
  await bindSecret(page);
  await page.reload();
}

test.describe("desktop tab-bar", () => {
  test("managed session shows a tab and attaches its terminal", async ({ page, ctx }) => {
    const name = await ctx.createSession();

    await openApp(page);

    await expect(tab(page, name)).toBeVisible({ timeout: 10_000 });
    await tab(page, name).click();
    await expect(tab(page, name)).toHaveClass(/is-active/, { timeout: 5_000 });
    await expect(page.locator(".desktop-shell__term-host")).toBeVisible();

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("close (×) opens confirm modal — cancel keeps the session alive", async ({ page, ctx }) => {
    const name = await ctx.createSession();

    await openApp(page);

    await tab(page, name).click();
    await tab(page, name).locator(".tab-bar__close").click();

    await expect(page.locator(".modal-dialog")).toBeVisible();
    await expect(page.locator(".modal-dialog__title")).toHaveText("关闭会话");
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.locator(".modal-dialog")).not.toBeVisible();

    expect(ctx.tmuxE2E(["list-sessions", "-F", "#{session_name}"]).split("\n")).toContain(name);

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("close (×) confirm destroys the session and removes its tab", async ({ page, ctx }) => {
    const keep = await ctx.createSession();
    const kill = await ctx.createSession();

    await openApp(page);

    await expect(tab(page, kill)).toBeVisible({ timeout: 10_000 });
    await tab(page, kill).click();
    await tab(page, kill).locator(".tab-bar__close").click();
    await expect(page.locator(".modal-dialog")).toBeVisible();
    await page.locator(".modal-dialog__actions button.is-danger").click();

    await expect(tab(page, kill)).toHaveCount(0, { timeout: 10_000 });
    const sessions = ctx.tmuxE2E(["list-sessions", "-F", "#{session_name}"]).split("\n");
    expect(sessions).not.toContain(kill);
    expect(sessions).toContain(keep);

    ctx.tmuxE2E(["kill-session", "-t", keep]);
  });

  test("rename via context menu commits on Enter", async ({ page, ctx }) => {
    const name = await ctx.createSession();
    const renamed = `${name}-r`;

    await openApp(page);

    await expect(tab(page, name)).toBeVisible({ timeout: 10_000 });
    await tab(page, name).click({ button: "right" });
    await page.locator(".context-menu__item", { hasText: "编辑名称" }).click();

    const input = page.locator(".tab-bar__rename-input");
    await expect(input).toBeVisible();
    await input.fill(renamed);
    await input.press("Enter");

    await expect(tab(page, renamed)).toBeVisible({ timeout: 10_000 });

    try { ctx.tmuxE2E(["kill-session", "-t", renamed]); } catch { /* renamed away */ }
  });

  test("rename via context menu cancels on Escape", async ({ page, ctx }) => {
    const name = await ctx.createSession();

    await openApp(page);

    await expect(tab(page, name)).toBeVisible({ timeout: 10_000 });
    await tab(page, name).click({ button: "right" });
    await page.locator(".context-menu__item", { hasText: "编辑名称" }).click();

    const input = page.locator(".tab-bar__rename-input");
    await expect(input).toBeVisible();
    await input.fill("ignored-value");
    await input.press("Escape");

    await expect(input).toHaveCount(0);
    await expect(tab(page, name)).toBeVisible();

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("switching tabs flips the active tab and reattaches that session", async ({ page, ctx }) => {
    const a = await ctx.createSession();
    const b = await ctx.createSession();
    ctx.tmuxE2E(["send-keys", "-t", a, "echo ALPHA_DESKTOP_MARK", "Enter"]);
    ctx.tmuxE2E(["send-keys", "-t", b, "echo BETA_DESKTOP_MARK", "Enter"]);

    await openApp(page);

    await expect(tab(page, a)).toBeVisible({ timeout: 10_000 });
    await tab(page, a).click();
    await expect(tab(page, a)).toHaveClass(/is-active/, { timeout: 5_000 });
    await expect(tab(page, b)).not.toHaveClass(/is-active/);
    expect(ctx.tmuxE2E(["capture-pane", "-p", "-t", a])).toContain("ALPHA_DESKTOP_MARK");

    await tab(page, b).click();
    await expect(tab(page, b)).toHaveClass(/is-active/, { timeout: 5_000 });
    await expect(tab(page, a)).not.toHaveClass(/is-active/);
    await expect(page.locator(".desktop-shell__term-host")).toBeVisible();
    expect(ctx.tmuxE2E(["capture-pane", "-p", "-t", b])).toContain("BETA_DESKTOP_MARK");

    ctx.tmuxE2E(["kill-session", "-t", a]);
    ctx.tmuxE2E(["kill-session", "-t", b]);
  });

  test("Ctrl+Tab cycles to the next tab and wraps around", async ({ page, ctx }) => {
    const a = await ctx.createSession();
    const b = await ctx.createSession();
    const c = await ctx.createSession();

    await openApp(page);

    await expect(tab(page, a)).toBeVisible({ timeout: 10_000 });
    await tab(page, a).click();
    await expect(tab(page, a)).toHaveClass(/is-active/, { timeout: 5_000 });

    await page.keyboard.press("Control+Tab");
    await expect(tab(page, b)).toHaveClass(/is-active/, { timeout: 5_000 });

    await page.keyboard.press("Control+Tab");
    await expect(tab(page, c)).toHaveClass(/is-active/, { timeout: 5_000 });

    await page.keyboard.press("Control+Tab");
    await expect(tab(page, a)).toHaveClass(/is-active/, { timeout: 5_000 });

    ctx.tmuxE2E(["kill-session", "-t", a]);
    ctx.tmuxE2E(["kill-session", "-t", b]);
    ctx.tmuxE2E(["kill-session", "-t", c]);
  });

  test("Ctrl+Shift+Tab cycles to the previous tab and wraps around", async ({ page, ctx }) => {
    const a = await ctx.createSession();
    const b = await ctx.createSession();
    const c = await ctx.createSession();

    await openApp(page);

    await expect(tab(page, a)).toBeVisible({ timeout: 10_000 });
    await tab(page, a).click();
    await expect(tab(page, a)).toHaveClass(/is-active/, { timeout: 5_000 });

    await page.keyboard.press("Control+Shift+Tab");
    await expect(tab(page, c)).toHaveClass(/is-active/, { timeout: 5_000 });

    await page.keyboard.press("Control+Shift+Tab");
    await expect(tab(page, b)).toHaveClass(/is-active/, { timeout: 5_000 });

    await page.keyboard.press("Control+Shift+Tab");
    await expect(tab(page, a)).toHaveClass(/is-active/, { timeout: 5_000 });

    ctx.tmuxE2E(["kill-session", "-t", a]);
    ctx.tmuxE2E(["kill-session", "-t", b]);
    ctx.tmuxE2E(["kill-session", "-t", c]);
  });

  test("+ button launches a new managed zsh session", async ({ page, ctx }) => {
    await openApp(page);

    await page.locator(".tab-bar__new").click();

    let names: string[] = [];
    for (let i = 0; i < 40; i++) {
      names = ctx.tmuxE2E(["list-sessions", "-F", "#{session_name}"]).split("\n").filter(Boolean);
      if (names.some((n) => n.startsWith("shell-"))) break;
      await page.waitForTimeout(200);
    }
    const newName = names.find((n) => n.startsWith("shell-"));
    expect(newName, `expected a shell-* session in ${JSON.stringify(names)}`).toBeTruthy();

    await expect(tab(page, newName!)).toBeVisible({ timeout: 10_000 });

    ctx.tmuxE2E(["kill-session", "-t", newName!]);
  });

  test("a managed session created after load appears as a tab via SSE", async ({ page, ctx }) => {
    await openApp(page);
    await page.waitForTimeout(500);

    const name = await ctx.createSession();

    await expect(tab(page, name)).toBeVisible({ timeout: 10_000 });

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("an unmanaged tmux session never shows up (managed-only filter)", async ({ page, ctx }) => {
    await openApp(page);
    await page.waitForTimeout(500);

    // Side-load a raw, unmanaged session directly onto the tmux server. The hub
    // must NOT surface it — only sessions it manages are shown.
    const external = `ext-${Date.now().toString().slice(-12)}`;
    ctx.tmuxE2E(["new-session", "-d", "-s", external, "sh"]);

    // Give the registry several poll cycles; the tab must stay absent.
    await page.waitForTimeout(3_000);
    await expect(tab(page, external)).toHaveCount(0);

    ctx.tmuxE2E(["kill-session", "-t", external]);
  });

  test("a session killed externally disappears from the tab-bar via SSE", async ({ page, ctx }) => {
    const name = await ctx.createSession();

    await openApp(page);
    await expect(tab(page, name)).toBeVisible({ timeout: 10_000 });

    ctx.tmuxE2E(["kill-session", "-t", name]);

    await expect(tab(page, name)).toHaveCount(0, { timeout: 10_000 });
  });

  test("image attach inserts the uploaded path into the input bar", async ({ page, ctx }) => {
    const name = await ctx.createSession();

    await openApp(page);

    await expect(tab(page, name)).toBeVisible({ timeout: 10_000 });
    await tab(page, name).click();
    await page.waitForTimeout(500);

    const fixturePath = join(process.cwd(), "tests/e2e/fixtures/red.png");
    await page.locator("input.mobile-toolbar__image-attach-input").setInputFiles(fixturePath);

    const ta = page.locator(".input-bar__textarea");
    await expect(ta).toHaveValue(/\.png\s*$/, { timeout: 5_000 });

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("clipboard paste of an image injects the path into the pane", async ({ page, ctx }) => {
    const name = await ctx.createSession();

    await openApp(page);

    await expect(tab(page, name)).toBeVisible({ timeout: 10_000 });
    await tab(page, name).click();
    await page.waitForTimeout(800);

    // Synthesize a paste with an image item on the root desktop-shell element.
    // The root paste handler uploads then sends the path straight to the pane.
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

    await page.waitForTimeout(1000);
    const captured = ctx.tmuxE2E(["capture-pane", "-p", "-t", name]);
    expect(captured).toMatch(/[\/\w-]+\.png/);

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("force-selection drag over a mouse-capturing app copies to the browser clipboard", async ({ page, ctx }) => {
    const name = await ctx.createSession();

    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await openApp(page);

    await expect(tab(page, name)).toBeVisible({ timeout: 10_000 });
    await tab(page, name).click();
    await page.waitForTimeout(500);

    // Fill the screen with full-width marker rows so a drag anywhere over the
    // terminal body is guaranteed to cross real (non-blank) cells — otherwise
    // xterm's getSelection() trims to "" and nothing is copied.
    ctx.tmuxE2E(["send-keys", "-t", name, "yes XXXXXXXXXXXXXXXXXXXXXXXXXXXX | head -40", "Enter"]);
    await page.waitForTimeout(1000);

    // Reproduce the real scenario: a TUI (claude code, vim) has CAPTURED the
    // mouse. A bare shell resets DEC private modes on every prompt redraw, so
    // we hold mouse tracking on with a sleep — during the sleep, mouse mode
    // stays active exactly as it would inside a real TUI. With mouse tracking
    // on, a plain drag is forwarded to the app; only the force-selection
    // modifier yields a local browser-side selection — the gesture this
    // feature documents.
    ctx.tmuxE2E(["send-keys", "-t", name, "printf '\\033[?1000h\\033[?1006h'; sleep 30", "Enter"]);
    await page.waitForTimeout(800);

    const screen = page.locator(".term-slot.is-active .xterm-screen");
    const box = await screen.boundingBox();
    if (!box) throw new Error("xterm screen has no bounding box");

    // Force-selection modifier is platform-fixed in xterm: Option(⌥)=Alt on
    // macOS (where Playwright's Desktop Chrome reports as Mac), Shift elsewhere.
    // Playwright merges the held modifier into the mouse events, so xterm sees
    // it on mousedown and bypasses mouse-reporting to do a local selection.
    const isMac = await page.evaluate(() => navigator.platform.toUpperCase().includes("MAC"));
    const forceKey = isMac ? "Alt" : "Shift";
    await page.keyboard.down(forceKey);
    await page.mouse.move(box.x + 10, box.y + 8);
    await page.mouse.down();
    await page.waitForTimeout(50);
    // Drag in two legs with a pause so xterm commits the growing selection
    // between our mid-drag samples (we sample the live selection on mousemove
    // because the app's mouse capture makes xterm clear it on mouseup).
    await page.mouse.move(box.x + 90, box.y + 70, { steps: 15 });
    await page.waitForTimeout(80);
    await page.mouse.move(box.x + 150, box.y + 120, { steps: 15 });
    await page.waitForTimeout(80);
    await page.mouse.up();
    await page.keyboard.up(forceKey);

    // Our own toast (not the remote app's) confirms the browser-side copy.
    await expect(page.getByText(/已复制 \d+ 字符到剪贴板/)).toBeVisible({ timeout: 5_000 });

    // And the text actually landed in THIS browser's clipboard — the X-filled
    // rows we just selected, not whatever the host's pbcopy held.
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip.length).toBeGreaterThan(0);
    expect(clip).toMatch(/X/);

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });
});
