/**
 * README 截图脚本——生成桌面与移动端 UI 截图，输出到 docs/screenshots/。
 *
 * 前置条件：本机已起 tmux-hub 服务（默认 :3101）且 TMUX_HUB_DEV_BIND_SECRET=1。
 *
 * 用法：
 *   bun run screenshots:readme
 *
 * 自定义端口：
 *   SHOT_PORT=3201 bun run screenshots:readme
 */
import { test } from "@playwright/test";
import { mkdirSync } from "node:fs";

const OUT_DIR = "docs/screenshots";

test.beforeAll(() => {
  mkdirSync(OUT_DIR, { recursive: true });
});

async function bootstrapAuth(page: import("@playwright/test").Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate(async () => {
    try {
      const r = await fetch("/system/auth-check", { credentials: "include" });
      if (r.ok) {
        const body = (await r.json()) as { secret: string };
        sessionStorage.setItem("hub.secret", body.secret);
      }
    } catch {}
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
}

test.describe("README screenshots", () => {
  test("desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await bootstrapAuth(page);
    await page.screenshot({ path: `${OUT_DIR}/desktop.png` });
  });

  test("mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await bootstrapAuth(page);
    await page.screenshot({ path: `${OUT_DIR}/mobile.png` });
  });
});
