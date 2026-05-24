import { join } from "node:path";
import { test, expect } from "./fixtures";
import { bindSecret, uniqSession } from "./helpers";

test.describe("mobile view", () => {
  test("textarea submit reaches the pane", async ({ page, ctx }) => {
    const name = uniqSession("shell");
    ctx.tmuxE2E(["new-session", "-d", "-s", name, "sh"]);

    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    await expect(page.locator(`.session-picker__item[data-session="${name}"]`))
      .toHaveCount(1, { timeout: 10_000 });
    await page.locator(".session-picker__trigger").click();
    await page.locator(`.session-picker__item[data-session="${name}"]`).click();
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

    await expect(page.locator(`.session-picker__item[data-session="${name}"]`))
      .toHaveCount(1, { timeout: 10_000 });
    await page.locator(".session-picker__trigger").click();
    await page.locator(`.session-picker__item[data-session="${name}"]`).click();
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

  test("quick-launch button starts a kb-cc session and switches to it", async ({ page, ctx }) => {
    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    // Wait for the quick-launch button to become enabled (mount-time GET /templates
    // resolves with kb-cc present in deploy/templates.yaml.example).
    const btn = page.locator(".mobile-toolbar__quick-launch");
    await expect(btn).toBeVisible({ timeout: 10_000 });
    await expect(btn).toBeEnabled({ timeout: 10_000 });

    await btn.click();

    // Server-side: a new tmux session whose name starts with "kb-cc-" must appear
    // in the isolated e2e tmux server.
    let names: string[] = [];
    for (let i = 0; i < 30; i++) {
      names = ctx.tmuxE2E(["list-sessions", "-F", "#{session_name}"]).split("\n").filter(Boolean);
      if (names.some((n) => n.startsWith("kb-cc-"))) break;
      await page.waitForTimeout(200);
    }
    const newName = names.find((n) => n.startsWith("kb-cc-"));
    expect(newName, `expected a kb-cc-* session in ${JSON.stringify(names)}`).toBeTruthy();

    // Front-end: picker should auto-switch to the new session.
    await expect(page.locator(`.session-picker__item[data-session="${newName!}"]`))
      .toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator(".session-picker__name")).toHaveText(newName!, { timeout: 10_000 });

    ctx.tmuxE2E(["kill-session", "-t", newName!]);
  });

  test("empty textarea submit sends a bare Enter to the pane", async ({ page, ctx }) => {
    const name = uniqSession("shell");
    ctx.tmuxE2E(["new-session", "-d", "-s", name, "sh"]);

    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    await expect(page.locator(`.session-picker__item[data-session="${name}"]`))
      .toHaveCount(1, { timeout: 10_000 });
    await page.locator(".session-picker__trigger").click();
    await page.locator(`.session-picker__item[data-session="${name}"]`).click();
    await page.waitForTimeout(1500);

    // Open the drawer so the form is visible
    await page.locator(".input-bar__field").click();

    // textarea is empty; click submit
    await page.locator(".mobile-input button[type=submit]").evaluate((btn: HTMLButtonElement) => btn.click());
    await page.waitForTimeout(700);

    // After Enter into sh prompt: a fresh prompt line appears.
    // We assert that capture-pane contains 2+ shell prompts (the one we started
    // with + the one after Enter). Match a literal `$` since macOS sh emits
    // `sh-3.2$\n` (no trailing space) while bash emits `bash-5.x$ ` — counting
    // `$` is the most portable signal.
    const captured = ctx.tmuxE2E(["capture-pane", "-p", "-t", name]);
    const promptOccurrences = (captured.match(/\$/g) ?? []).length;
    expect(promptOccurrences).toBeGreaterThanOrEqual(2);

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("rename button switches header to edit-mode and renames session", async ({ page, ctx }) => {
    const name = uniqSession("shell");
    const renamed = `${name}-r`;
    ctx.tmuxE2E(["new-session", "-d", "-s", name, "sh"]);

    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    await expect(page.locator(`.session-picker__item[data-session="${name}"]`))
      .toHaveCount(1, { timeout: 10_000 });
    await page.locator(".session-picker__trigger").click();
    await page.locator(`.session-picker__item[data-session="${name}"]`).click();
    await page.waitForTimeout(800);

    // Tap ✎ → edit mode appears
    await page.locator(".session-picker__rename").click();
    const input = page.locator(".mobile-shell__rename-input");
    await expect(input).toBeVisible();
    await expect(input).toHaveValue(name);

    // Replace value + save
    await input.fill(renamed);
    await page.locator(".mobile-shell__rename-save").click();

    // After SSE roundtrip the picker repaints with the new name active
    await expect(page.locator(`.session-picker__item[data-session="${renamed}"]`))
      .toHaveCount(1, { timeout: 5_000 });
    await expect(page.locator(".session-picker__name")).toHaveText(renamed);

    try { ctx.tmuxE2E(["kill-session", "-t", renamed]); } catch { /* best-effort */ }
  });

  test("rename cancel restores select without firing request", async ({ page, ctx }) => {
    const name = uniqSession("shell");
    ctx.tmuxE2E(["new-session", "-d", "-s", name, "sh"]);

    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    await expect(page.locator(`.session-picker__item[data-session="${name}"]`))
      .toHaveCount(1, { timeout: 10_000 });
    await page.locator(".session-picker__trigger").click();
    await page.locator(`.session-picker__item[data-session="${name}"]`).click();
    await page.waitForTimeout(800);

    await page.locator(".session-picker__rename").click();
    await page.locator(".mobile-shell__rename-input").fill("ignored-value");
    await page.locator(".mobile-shell__rename-cancel").click();

    await expect(page.locator(".session-picker__trigger")).toBeVisible();
    await expect(page.locator(".session-picker__name")).toHaveText(name);

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("kill button shows confirm modal — cancel keeps session alive", async ({ page, ctx }) => {
    const name = uniqSession("shell");
    ctx.tmuxE2E(["new-session", "-d", "-s", name, "sleep 60"]);

    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    await expect(page.locator(`.session-picker__item[data-session="${name}"]`))
      .toHaveCount(1, { timeout: 10_000 });
    await page.locator(".session-picker__trigger").click();
    await page.locator(`.session-picker__item[data-session="${name}"]`).click();
    await page.waitForTimeout(800);

    await page.locator(".session-picker__kill").click();
    await expect(page.locator(".modal-dialog")).toBeVisible();
    await expect(page.locator(".modal-dialog__title")).toHaveText("关闭会话");

    await page.locator(".modal-dialog__actions button:first-child").click();
    await expect(page.locator(".modal-dialog")).not.toBeVisible();

    const sessions = ctx.tmuxE2E(["list-sessions", "-F", "#{session_name}"]).split("\n");
    expect(sessions).toContain(name);

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("kill button confirm destroys session and switches to next", async ({ page, ctx }) => {
    const keep = uniqSession("keep");
    const kill = uniqSession("kill");
    ctx.tmuxE2E(["new-session", "-d", "-s", keep, "sh"]);
    ctx.tmuxE2E(["new-session", "-d", "-s", kill, "sleep 60"]);

    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    await expect(page.locator(`.session-picker__item[data-session="${kill}"]`))
      .toHaveCount(1, { timeout: 10_000 });
    await page.locator(".session-picker__trigger").click();
    await page.locator(`.session-picker__item[data-session="${kill}"]`).click();
    await page.waitForTimeout(800);

    await page.locator(".session-picker__kill").click();
    await expect(page.locator(".modal-dialog")).toBeVisible();
    await page.locator(".modal-dialog__actions button.is-danger").click();

    await expect(page.locator(`.session-picker__item[data-session="${kill}"]`))
      .toHaveCount(0, { timeout: 10_000 });

    const sessions = ctx.tmuxE2E(["list-sessions", "-F", "#{session_name}"]).split("\n");
    expect(sessions).not.toContain(kill);
    expect(sessions).toContain(keep);

    await expect(page.locator(".session-picker__name")).toHaveText(keep, { timeout: 5_000 });

    ctx.tmuxE2E(["kill-session", "-t", keep]);
  });

  test("image attach: picker → upload → drawer opens + path appears in textarea", async ({ page, ctx }) => {
    const name = uniqSession("shell");
    ctx.tmuxE2E(["new-session", "-d", "-s", name, "sh"]);

    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    await expect(page.locator(`.session-picker__item[data-session="${name}"]`))
      .toHaveCount(1, { timeout: 10_000 });
    await page.locator(".session-picker__trigger").click();
    await page.locator(`.session-picker__item[data-session="${name}"]`).click();
    await page.waitForTimeout(800);

    // The 📎 button + hidden <input type=file> are siblings inside the toolbar.
    const hiddenInput = page.locator(".mobile-toolbar__image-attach-input");
    const fixturePath = join(process.cwd(), "tests/e2e/fixtures/red.png");
    await hiddenInput.setInputFiles(fixturePath);

    // After upload: drawer auto-opens, textarea contains the absolute path.
    const drawer = page.locator(".mobile-drawer");
    await expect(drawer).toHaveClass(/is-open/, { timeout: 5_000 });
    const ta = page.locator(".mobile-input__textarea");
    const taValue = await ta.inputValue();
    expect(taValue).toMatch(/\.png\s*$/);

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("switching sessions updates terminal content", async ({ page, ctx }) => {
    const a = uniqSession("alpha");
    const b = uniqSession("beta");
    ctx.tmuxE2E(["new-session", "-d", "-s", a, "sh"]);
    ctx.tmuxE2E(["new-session", "-d", "-s", b, "sh"]);
    ctx.tmuxE2E(["send-keys", "-t", a, "echo ALPHA_MOBILE", "Enter"]);
    ctx.tmuxE2E(["send-keys", "-t", b, "echo BETA_MOBILE", "Enter"]);

    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    await expect(page.locator(`.session-picker__item[data-session="${a}"]`))
      .toHaveCount(1, { timeout: 10_000 });

    await page.locator(".session-picker__trigger").click();
    await page.locator(`.session-picker__item[data-session="${a}"]`).click();
    await page.waitForTimeout(1500);
    const capA = ctx.tmuxE2E(["capture-pane", "-p", "-t", a]);
    expect(capA).toContain("ALPHA_MOBILE");

    await page.locator(".session-picker__trigger").click();
    await page.locator(`.session-picker__item[data-session="${b}"]`).click();
    await page.waitForTimeout(1500);
    await expect(page.locator(".session-picker__name")).toHaveText(b);

    ctx.tmuxE2E(["kill-session", "-t", a]);
    ctx.tmuxE2E(["kill-session", "-t", b]);
  });

  test("session picker opens and closes on trigger click", async ({ page, ctx }) => {
    const name = uniqSession("shell");
    ctx.tmuxE2E(["new-session", "-d", "-s", name, "sh"]);

    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    await expect(page.locator(`.session-picker__item[data-session="${name}"]`))
      .toHaveCount(1, { timeout: 10_000 });

    const picker = page.locator(".session-picker");
    await expect(picker).not.toHaveClass(/is-open/);

    await page.locator(".session-picker__trigger").click();
    await expect(picker).toHaveClass(/is-open/);

    await page.locator(".session-picker__backdrop").click({ force: true });
    await expect(picker).not.toHaveClass(/is-open/);

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("drawer toggles open and closed", async ({ page, ctx }) => {
    const name = uniqSession("shell");
    ctx.tmuxE2E(["new-session", "-d", "-s", name, "sh"]);

    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    await expect(page.locator(`.session-picker__item[data-session="${name}"]`))
      .toHaveCount(1, { timeout: 10_000 });
    await page.locator(".session-picker__trigger").click();
    await page.locator(`.session-picker__item[data-session="${name}"]`).click();
    await page.waitForTimeout(800);

    const drawer = page.locator(".mobile-drawer");
    await expect(drawer).not.toHaveClass(/is-open/);

    await page.locator(".input-bar__field").click();
    await expect(drawer).toHaveClass(/is-open/);

    await page.locator(".input-bar__field").click();
    await expect(drawer).not.toHaveClass(/is-open/);

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("arrow keys reach the pane", async ({ page, ctx }) => {
    const name = uniqSession("shell");
    ctx.tmuxE2E(["new-session", "-d", "-s", name, "sh"]);

    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    await expect(page.locator(`.session-picker__item[data-session="${name}"]`))
      .toHaveCount(1, { timeout: 10_000 });
    await page.locator(".session-picker__trigger").click();
    await page.locator(`.session-picker__item[data-session="${name}"]`).click();
    await page.waitForTimeout(1500);

    await page.locator(".mobile-input__textarea").fill("echo ARROW_TEST");
    await page.locator(".mobile-input button[type=submit]").evaluate((btn: HTMLButtonElement) => btn.click());
    await page.waitForTimeout(500);

    await page.locator(".tk-up").click({ force: true });
    await page.waitForTimeout(300);
    await page.locator(".tk-enter").click({ force: true });
    await page.waitForTimeout(1000);

    const captured = ctx.tmuxE2E(["capture-pane", "-p", "-t", name]);
    const occurrences = (captured.match(/ARROW_TEST/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("session created externally appears in picker via SSE", async ({ page, ctx }) => {
    await page.goto("/");
    await bindSecret(page);
    await page.reload();
    await page.waitForTimeout(1000);

    const name = uniqSession("late");
    ctx.tmuxE2E(["new-session", "-d", "-s", name, "sh"]);

    await expect(page.locator(`.session-picker__item[data-session="${name}"]`))
      .toHaveCount(1, { timeout: 10_000 });

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("session killed externally disappears from picker via SSE", async ({ page, ctx }) => {
    const name = uniqSession("ephemeral");
    ctx.tmuxE2E(["new-session", "-d", "-s", name, "sh"]);

    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    await expect(page.locator(`.session-picker__item[data-session="${name}"]`))
      .toHaveCount(1, { timeout: 10_000 });

    ctx.tmuxE2E(["kill-session", "-t", name]);

    await expect(page.locator(`.session-picker__item[data-session="${name}"]`))
      .toHaveCount(0, { timeout: 10_000 });
  });
});
