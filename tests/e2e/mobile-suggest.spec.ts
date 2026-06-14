/**
 * e2e: 移动端 shell 态 NL→复核→发送 全链测试（stub CC Switch）
 *
 * 跑法：需要一个 stub HTTP server 模拟 CC Switch，以及 hub 以 TMUX_HUB_SUGGEST=1 启动。
 * 该 spec 定义了完整的测试意图与选择器约定；实际 CI 联跑需：
 *   1. 启动 stub CC Switch（见下方 STUB_PORT 逻辑）
 *   2. hub 启动时注入 TMUX_HUB_SUGGEST=1 + TMUX_HUB_SUGGEST_ENDPOINT=<stub>/v1/chat/completions
 * loop 内只做文件存在 + tsc 类型校验（见 acceptance.md §10）。
 */

import { test, expect } from "@playwright/test";

const STUB_COMMAND = "ls -la"; // stub CC Switch 固定返回此命令

// stub CC Switch server：固定返回一条命令，端口 0 自动分配。
let stubServer: ReturnType<typeof Bun.serve> | null = null;
let stubPort = 0;

test.beforeAll(async () => {
  // 启动内嵌 stub 服务，仿 OpenAI chat/completions 响应。
  stubServer = Bun.serve({
    port: 0,
    fetch(req) {
      if (req.method === "POST" && req.url.includes("/v1/chat/completions")) {
        const body = JSON.stringify({
          choices: [{ message: { content: STUB_COMMAND } }],
        });
        return new Response(body, {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  stubPort = stubServer.port ?? 0;
});

test.afterAll(() => {
  stubServer?.stop();
  stubServer = null;
});

test("移动端 shell 态：NL → 复核(AI 提示) → 发送", async ({ page }) => {
  // 注：本 spec 内跑时假设 hub 已以 TMUX_HUB_SUGGEST=1 + TMUX_HUB_SUGGEST_ENDPOINT
  // 指向 stubPort 启动（playwright.config.ts globalSetup 或 per-spec Bun.spawn 接线）。
  // 以下断言对应 Task 9 渲染的 DOM 结构。

  await page.goto("/");

  const ta = page.locator(".input-bar__textarea");
  await ta.click();
  await ta.fill("列出当前目录文件");

  // 第一次「发送」→ 触发模型（shell 态）
  await page.locator(".input-bar__send").click();

  // 复核态：AI 提示条出现、textarea 替换为 stub 命令
  await expect(page.locator(".input-bar__ai-banner")).toBeVisible({ timeout: 8000 });
  await expect(ta).toHaveValue(STUB_COMMAND);
  await expect(page.locator(".mobile-input-bar.is-review")).toBeVisible();
  await expect(page.locator(".input-bar__undo")).toBeVisible();

  // 第二次「发送」→ 字面进 tmux；输入框清空、退出 review 态
  await page.locator(".input-bar__send").click();
  await expect(ta).toHaveValue("");
  await expect(page.locator(".input-bar__ai-banner")).toBeHidden();
});

test("移动端 review 态：撤销还原原文，回 draft", async ({ page }) => {
  await page.goto("/");

  const ta = page.locator(".input-bar__textarea");
  await ta.click();
  await ta.fill("把分支推上去");

  await page.locator(".input-bar__send").click();

  // 等进入 review
  await expect(page.locator(".input-bar__ai-banner")).toBeVisible({ timeout: 8000 });

  // 点撤销
  await page.locator(".input-bar__undo").click();

  // 回 draft：banner 消失，textarea 还原原文
  await expect(page.locator(".input-bar__ai-banner")).toBeHidden();
  await expect(ta).toHaveValue("把分支推上去");
});
