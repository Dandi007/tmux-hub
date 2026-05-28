/**
 * README 截图脚本——生成桌面与移动端 UI 截图，输出到 docs/screenshots/。
 *
 * 流程：
 *   1. 通过 POST /templates/shell/run spawn 一个 demo session（自动进 managedDb）
 *   2. tmux send-keys 注入无害命令（echo / date / uname）
 *   3. Playwright 把 active session 切到 demo session，截图
 *   4. 截完 kill demo session
 *
 * 前置条件：本机 tmux-hub 服务起在 :3101 且 TMUX_HUB_DEV_BIND_SECRET=1，
 * 且 ~/.config/tmux-hub/templates.yaml 含 id=shell template。
 *
 * 用法：
 *   bun run screenshots:readme
 */
import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const OUT_DIR = "docs/screenshots";
const BASE = `http://127.0.0.1:${process.env.SHOT_PORT ?? "3101"}`;

let demoSession = "";

function tmux(args: string[]) {
  return spawnSync("tmux", args, { encoding: "utf8" });
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function fetchSecret(): Promise<string> {
  const r = await fetch(`${BASE}/system/auth-check`);
  if (!r.ok) throw new Error(`auth-check failed ${r.status}`);
  const body = (await r.json()) as { secret: string };
  return body.secret;
}

async function spawnDemo(secret: string): Promise<string> {
  const r = await fetch(`${BASE}/templates/shell/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Secret": secret },
    body: JSON.stringify({ cwd: "~" }),
  });
  if (!r.ok) throw new Error(`spawn demo failed ${r.status} ${await r.text()}`);
  const body = (await r.json()) as { name: string };
  return body.name;
}

test.beforeAll(async () => {
  mkdirSync(OUT_DIR, { recursive: true });
  const secret = await fetchSecret();
  demoSession = await spawnDemo(secret);
  // 等 registry poll (2s) + broadcaster prime + zsh rc 链加载完毕，避免 send-keys 被吞
  await sleep(4000);
  tmux(["send-keys", "-t", demoSession, "clear", "Enter"]);
  await sleep(300);
  tmux(["send-keys", "-t", demoSession, "echo hello from tmux-hub", "Enter"]);
  await sleep(300);
  tmux(["send-keys", "-t", demoSession, "date", "Enter"]);
  await sleep(300);
  tmux(["send-keys", "-t", demoSession, "uname -srm", "Enter"]);
  await sleep(300);
  tmux(["send-keys", "-t", demoSession, "ls /tmp | head -6", "Enter"]);
  await sleep(1500);
});

test.afterAll(() => {
  if (demoSession) tmux(["kill-session", "-t", demoSession]);
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
  await page.waitForTimeout(1500);
}

test.describe("README screenshots", () => {
  test("desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await bootstrapAuth(page);
    const tab = page.locator(`.tab-bar__tab[data-session="${demoSession}"]`);
    await expect(tab).toBeVisible({ timeout: 8_000 });
    await tab.click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${OUT_DIR}/desktop.png` });
  });

  test("mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await bootstrapAuth(page);
    const trigger = page.locator(".session-picker__trigger");
    await expect(trigger).toBeVisible({ timeout: 8_000 });
    const current = (await trigger.textContent())?.trim() ?? "";
    if (!current.includes(demoSession)) {
      await trigger.click();
      const demoItem = page.locator(".session-picker__item-name", { hasText: demoSession }).first();
      await expect(demoItem).toBeVisible({ timeout: 5_000 });
      await demoItem.click();
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${OUT_DIR}/mobile.png` });
  });
});
