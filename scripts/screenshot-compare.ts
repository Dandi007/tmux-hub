/**
 * UI 截图脚本 — 用于 before/after 视觉对比。
 *
 * 用法：
 *   1. 在 main 分支启动 dev server: bun run dev
 *   2. 运行: npx playwright test scripts/screenshot-compare.ts --config scripts/screenshot-compare.config.ts
 *      截图保存到 screenshots/before/
 *   3. 切到 feature 分支，重启 dev server
 *   4. 运行: SHOT_DIR=after npx playwright test scripts/screenshot-compare.ts --config scripts/screenshot-compare.config.ts
 *      截图保存到 screenshots/after/
 *   5. 对比 screenshots/before/ 和 screenshots/after/
 */
import { test } from "@playwright/test";

const dir = process.env.SHOT_DIR ?? "current";
const outDir = `screenshots/${dir}`;

test.describe("UI Screenshots", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.evaluate(async () => {
      try {
        const r = await fetch("/system/auth-check", { credentials: "include" });
        if (r.ok) {
          const body = (await r.json()) as { secret: string };
          sessionStorage.setItem("hub.secret", body.secret);
        }
      } catch {}
    });
    await page.goto("/");
    await page.waitForTimeout(1500);
  });

  test("desktop — full page", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${outDir}/desktop-full.png`, fullPage: true });
  });

  test("desktop — session picker open", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.waitForTimeout(2000);
    const picker = page.locator(".session-picker__trigger");
    if (await picker.isVisible()) {
      await picker.click();
      await page.waitForTimeout(500);
    }
    await page.screenshot({ path: `${outDir}/desktop-picker-open.png`, fullPage: true });
  });

  test("desktop — sidebar toggle (if exists)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.waitForTimeout(2000);
    const toggle = page.locator(".desktop-shell__sidebar-toggle");
    if (await toggle.isVisible()) {
      await toggle.click();
      await page.waitForTimeout(500);
    }
    await page.screenshot({ path: `${outDir}/desktop-sidebar.png`, fullPage: true });
  });

  test("mobile — full page", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${outDir}/mobile-full.png`, fullPage: true });
  });

  test("mobile — session picker open", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.waitForTimeout(2000);
    const picker = page.locator(".session-picker__trigger");
    if (await picker.isVisible()) {
      await picker.click();
      await page.waitForTimeout(500);
    }
    await page.screenshot({ path: `${outDir}/mobile-picker-open.png`, fullPage: true });
  });
});
