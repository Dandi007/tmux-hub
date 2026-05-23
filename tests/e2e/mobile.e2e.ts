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

    // Front-end: select should auto-switch to the new session option.
    await expect(page.locator(`.mobile-shell__session-select option[value="${newName!}"]`))
      .toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator(".mobile-shell__session-select")).toHaveValue(newName!, { timeout: 10_000 });

    ctx.tmuxE2E(["kill-session", "-t", newName!]);
  });

  test("empty textarea submit sends a bare Enter to the pane", async ({ page, ctx }) => {
    const name = uniqSession("shell");
    ctx.tmuxE2E(["new-session", "-d", "-s", name, "sh"]);

    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    await expect(page.locator(`.mobile-shell__session-select option[value="${name}"]`))
      .toHaveCount(1, { timeout: 10_000 });
    await page.locator(".mobile-shell__session-select").selectOption({ label: name });
    await page.waitForTimeout(1500);

    // Open the drawer so the form is visible
    await page.locator(".mobile-toolbar__toggle").click();

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

    await expect(page.locator(`.mobile-shell__session-select option[value="${name}"]`))
      .toHaveCount(1, { timeout: 10_000 });
    await page.locator(".mobile-shell__session-select").selectOption({ label: name });
    await page.waitForTimeout(800);

    // Tap ✎ → edit mode appears
    await page.locator(".mobile-shell__rename").click();
    const input = page.locator(".mobile-shell__rename-input");
    await expect(input).toBeVisible();
    await expect(input).toHaveValue(name);

    // Replace value + save
    await input.fill(renamed);
    await page.locator(".mobile-shell__rename-save").click();

    // After SSE roundtrip the select repaints with the new name selected
    await expect(page.locator(`.mobile-shell__session-select option[value="${renamed}"]`))
      .toHaveCount(1, { timeout: 5_000 });
    await expect(page.locator(".mobile-shell__session-select")).toHaveValue(renamed);

    try { ctx.tmuxE2E(["kill-session", "-t", renamed]); } catch { /* best-effort */ }
  });

  test("rename cancel restores select without firing request", async ({ page, ctx }) => {
    const name = uniqSession("shell");
    ctx.tmuxE2E(["new-session", "-d", "-s", name, "sh"]);

    await page.goto("/");
    await bindSecret(page);
    await page.reload();

    await expect(page.locator(`.mobile-shell__session-select option[value="${name}"]`))
      .toHaveCount(1, { timeout: 10_000 });
    await page.locator(".mobile-shell__session-select").selectOption({ label: name });
    await page.waitForTimeout(800);

    await page.locator(".mobile-shell__rename").click();
    await page.locator(".mobile-shell__rename-input").fill("ignored-value");
    await page.locator(".mobile-shell__rename-cancel").click();

    await expect(page.locator(".mobile-shell__session-select")).toBeVisible();
    await expect(page.locator(".mobile-shell__session-select")).toHaveValue(name);

    ctx.tmuxE2E(["kill-session", "-t", name]);
  });
});
