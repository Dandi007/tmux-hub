# Mobile Fixes R2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec `docs/superpowers/specs/2026-05-23-mobile-fixes-r2-design.md` 的三件事：移动端 session rename、移动端空 textarea 提交 = 纯回车、图片上传（前后端，桌面同步）。

**Architecture:** 移动端 rename 借鉴桌面端 UX，抽 `src/web/shared/rename-controller.ts` 共享 HTTP 调用；空提交去掉一行守卫；图片上传新增带外 HTTP multipart 路由（不动 WS 协议），落盘到 `TMUX_HUB_IMAGE_DIR` env 配置的目录，前端共享 `src/web/upload/image-upload.ts`，移动端把绝对路径注入 drawer textarea，桌面端按钮直发 + 剪贴板粘贴拦截。

**Tech Stack:** Bun runtime · Hono HTTP · xterm.js · bun:test (单元/集成) · Playwright (E2E) · TypeScript

**Branch / Worktree:** `feat/mobile-fixes-r2` @ `.claude/worktrees/feat-mobile-fixes-r2/`
**Draft PR:** #6

---

## 任务总览

1. 抽 `shared/rename-controller.ts`（纯重构）
2. 移动端空 textarea 提交 = Enter
3. 移动端 session rename UI
4. 服务端 config：`IMAGE_DIR` + `MAX_IMAGE_BYTES` env
5. 服务端 image-upload 纯逻辑（mime → ext、路径生成）
6. 服务端 image-upload Hono 路由 + 集成测试 + 接入 main
7. `deploy/hub.env.example` 追加 `TMUX_HUB_IMAGE_DIR`
8. 前端共享 `upload/image-upload.ts`
9. 移动端 `image-attach.ts` 按钮 + 接入 mobile-view
10. 桌面端 session header 📎 按钮
11. 桌面端剪贴板粘贴拦截
12. CSS：rename 编辑态 + attach 按钮
13. PR 描述更新 + 切 ready

---

## Task 1: 抽 `shared/rename-controller.ts`（纯重构）

**目的**：把桌面端 `session-list.ts:7-17` 内联的 `renameSession` 函数搬到共享模块，桌面端改用 import；为 Task 3 移动端 rename 复用做准备。零行为变更。

**Files:**
- Create: `src/web/shared/rename-controller.ts`
- Modify: `src/web/desktop/session-list.ts:1-17`

- [ ] **Step 1: 创建 shared 模块**

Create `src/web/shared/rename-controller.ts`:

```ts
import { hubFetch } from "../hub-fetch";

export async function renameSession(from: string, to: string): Promise<void> {
  const r = await hubFetch(`/sessions/${encodeURIComponent(from)}/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => r.statusText);
    throw new Error(text || `HTTP ${r.status}`);
  }
}
```

- [ ] **Step 2: 桌面端 import 改为共享版**

Edit `src/web/desktop/session-list.ts`:
- 删除 1-17 行的 `hubFetch` import（如果只剩 rename 用到）和 `renameSession` 函数定义；
- 在顶部 import 区追加 `import { renameSession } from "../shared/rename-controller";`。

最终 `src/web/desktop/session-list.ts` 顶部应为：

```ts
import type { SessionInfo, ServerEvent } from "@shared/protocol";
import { subscribeEvents } from "../sse-client";
import { isGrammarOk } from "@shared/session-name";
import { showToast } from "../ui/toast";
import { renameSession } from "../shared/rename-controller";
```

注意：检查文件其余位置是否还在用 `hubFetch`；如果用，保留 hubFetch import；如果不用就一并删除（让 `bun run build:web` 兜底 unused import 检查）。

- [ ] **Step 3: 跑构建确认无回归**

Run: `bun run build:web`
Expected: 构建成功，无 type / unused-import 错误。

- [ ] **Step 4: 跑现有测试套件确认未破坏行为**

Run: `bun test tests/unit tests/integration`
Expected: 全部 PASS（这次重构不带新测试，依赖现有 desktop e2e 在 Task 12 之前不跑也行；现有单元 / 集成测试覆盖不到 rename UI）。

- [ ] **Step 5: Commit**

```bash
git add src/web/shared/rename-controller.ts src/web/desktop/session-list.ts
git commit -m "refactor(rename): extract renameSession to src/web/shared/rename-controller for mobile reuse"
```

---

## Task 2: 移动端空 textarea 提交 = 纯 Enter

**目的**：去掉 `input-box.ts` 第 29 行 `if (!text) return;`，让空提交也发送 `{kind:"key", name:"Enter"}`。

**Files:**
- Modify: `src/web/mobile/input-box.ts:26-42`
- Test: `tests/e2e/mobile.e2e.ts` (追加 1 个 case)

- [ ] **Step 1: 写失败的 E2E**

Append to `tests/e2e/mobile.e2e.ts` inside `test.describe("mobile view", () => { ... })`:

```ts
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
  // with + the one after Enter). Use a permissive substring count.
  const captured = ctx.tmuxE2E(["capture-pane", "-p", "-t", name]);
  const promptOccurrences = (captured.match(/\$ /g) ?? []).length;
  expect(promptOccurrences).toBeGreaterThanOrEqual(2);

  ctx.tmuxE2E(["kill-session", "-t", name]);
});
```

- [ ] **Step 2: 跑 E2E，确认现在 FAIL**

Run: `bunx playwright test tests/e2e/mobile.e2e.ts -g "empty textarea submit"`
Expected: FAIL — 现有 `if (!text) return` 使得点提交什么也不发，只看到 1 个 prompt。

- [ ] **Step 3: 实现修改**

Edit `src/web/mobile/input-box.ts`，将 `wrap.addEventListener("submit", ...)` 整段替换为：

```ts
wrap.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = ta.value;
  // Empty submit means "send a bare Enter" — equivalent to tapping Enter on
  // the special-keys bar but with zero extra steps. Non-empty: send the text
  // through tmux send-keys -l first, then a real Enter key event (so raw-mode
  // TUIs receive the byte sequence their application mode expects, not a
  // literal 0x0D appended to the text).
  if (text) send({ kind: "keys", literal: text });
  send({ kind: "key", name: "Enter" });
  ta.value = "";
});
```

- [ ] **Step 4: 跑 E2E，确认 PASS**

Run: `bunx playwright test tests/e2e/mobile.e2e.ts -g "empty textarea submit"`
Expected: PASS

- [ ] **Step 5: 跑全 mobile e2e 确认没破坏既有 case**

Run: `bunx playwright test tests/e2e/mobile.e2e.ts`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add src/web/mobile/input-box.ts tests/e2e/mobile.e2e.ts
git commit -m "feat(mobile): empty textarea submit = bare Enter (no separate button needed)"
```

---

## Task 3: 移动端 session rename UI

**目的**：在 mobile header `<select>` 旁加 ✎ 按钮，点开切换到 edit-mode（input + 保存 + 取消）。复用 Task 1 的 `renameSession`。

**Files:**
- Modify: `src/web/mobile/mobile-view.ts:13-19` (header 渲染) + 附近
- Test: `tests/e2e/mobile.e2e.ts` (追加 case)

- [ ] **Step 1: 写失败的 E2E**

Append to `tests/e2e/mobile.e2e.ts`:

```ts
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

  ctx.tmuxE2E(["kill-session", "-t", renamed]).catch(() => {});
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
```

- [ ] **Step 2: 跑 E2E，确认 FAIL（没按钮没 input）**

Run: `bunx playwright test tests/e2e/mobile.e2e.ts -g "rename"`
Expected: FAIL — `.mobile-shell__rename` 找不到。

- [ ] **Step 3: 实现 mobile-view.ts header 改动**

Edit `src/web/mobile/mobile-view.ts`：

A. 顶部 import 区追加：
```ts
import { renameSession } from "../shared/rename-controller";
```

B. 替换 header 构造段（原 13-19 行）为：

```ts
const header = document.createElement("header");
header.className = "mobile-shell__header";

const select = document.createElement("select");
select.className = "mobile-shell__session-select";

const renameBtn = document.createElement("button");
renameBtn.type = "button";
renameBtn.className = "mobile-shell__rename";
renameBtn.setAttribute("aria-label", "重命名当前 session");
renameBtn.textContent = "✎";

header.append(select, renameBtn);
root.appendChild(header);
```

C. 在 `openedName` 声明附近（约 27 行后）追加 rename 编辑模式控制器。在 `select.addEventListener("change", ...)` 这一行**之前**插入：

```ts
const enterRenameMode = (current: string): void => {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "mobile-shell__rename-input";
  input.value = current;
  input.spellcheck = false;
  input.autocapitalize = "off";
  input.autocomplete = "off";

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "mobile-shell__rename-save";
  saveBtn.textContent = "保存";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "mobile-shell__rename-cancel";
  cancelBtn.textContent = "取消";

  // Replace [select][✎] with [input][保存][取消]
  header.replaceChildren(input, saveBtn, cancelBtn);

  const exitRenameMode = (): void => {
    header.replaceChildren(select, renameBtn);
  };

  const commit = async (): Promise<void> => {
    const next = input.value.trim();
    if (next === "" || next === current) { exitRenameMode(); return; }
    if (!isGrammarOk(next)) {
      showToast(`新名字不合法：${next}（只允许 [a-zA-Z0-9_-]，1-64 字符）`, "error");
      return; // stay in edit mode so user can fix it
    }
    try {
      await renameSession(current, next);
      // SSE session_removed (old) + session_created (new) repaint the select
      // and refreshSelect() picks the new name as current.
      exitRenameMode();
    } catch (e) {
      showToast(`重命名失败：${(e as Error).message}`, "error");
    }
  };

  saveBtn.addEventListener("click", () => { void commit(); });
  cancelBtn.addEventListener("click", exitRenameMode);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); void commit(); }
    else if (e.key === "Escape") { e.preventDefault(); exitRenameMode(); }
  });

  setTimeout(() => { input.focus(); input.select(); }, 0);
};

renameBtn.addEventListener("click", () => {
  const current = select.value;
  if (!current) return;
  enterRenameMode(current);
});
```

注意：`isGrammarOk` 和 `showToast` 已经在文件顶部 import；不需要新增 import。

- [ ] **Step 4: 跑 E2E，确认 rename + cancel 两个 case 都 PASS**

Run: `bunx playwright test tests/e2e/mobile.e2e.ts -g "rename"`
Expected: 2 个 case 都 PASS

- [ ] **Step 5: 跑 desktop e2e 确认共享 rename-controller 没回归**

Run: `bunx playwright test tests/e2e/desktop.e2e.ts`
Expected: PASS（如果桌面端也跑 rename case；不跑也无妨，下游 Task 12 CSS 不会影响 controller）

- [ ] **Step 6: Commit**

```bash
git add src/web/mobile/mobile-view.ts tests/e2e/mobile.e2e.ts
git commit -m "feat(mobile): inline session rename in header via shared rename-controller"
```

---

## Task 4: 服务端 config — `IMAGE_DIR` + `MAX_IMAGE_BYTES`

**目的**：把图片落盘根目录和大小上限做成 env-driven 常量，沿用现有 `TMUX_HUB_*` 命名 + `expandHome` 工具。

**Files:**
- Modify: `src/server/config.ts:44-50`
- Test: `tests/unit/image-dir.test.ts`

- [ ] **Step 1: 写失败的单元测试**

Create `tests/unit/image-dir.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

function readConsts(env: Record<string, string | undefined> = {}): { IMAGE_DIR: string; MAX_IMAGE_BYTES: number } {
  const script = `
    const c = await import("./src/server/config.ts");
    process.stdout.write(JSON.stringify({ IMAGE_DIR: c.IMAGE_DIR, MAX_IMAGE_BYTES: c.MAX_IMAGE_BYTES }));
  `;
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("TMUX_HUB_")) continue;
    if (typeof v === "string") cleanEnv[k] = v;
  }
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) cleanEnv[k] = v;
  }
  const res = spawnSync("bun", ["-e", script], { env: cleanEnv });
  if (res.status !== 0) throw new Error(`bun -e failed: ${res.stderr.toString()}`);
  return JSON.parse(res.stdout.toString());
}

describe("IMAGE_DIR / MAX_IMAGE_BYTES env resolution", () => {
  test("defaults: ~/Pictures/tmux-hub + 20MB", () => {
    const c = readConsts({});
    expect(c.IMAGE_DIR).toBe(`${homedir()}/Pictures/tmux-hub`);
    expect(c.MAX_IMAGE_BYTES).toBe(20 * 1024 * 1024);
  });

  test("respects absolute path override", () => {
    const c = readConsts({ TMUX_HUB_IMAGE_DIR: "/Volumes/Data/tmux-hub-images" });
    expect(c.IMAGE_DIR).toBe("/Volumes/Data/tmux-hub-images");
  });

  test("respects ~/... override (expanded)", () => {
    const c = readConsts({ TMUX_HUB_IMAGE_DIR: "~/custom-img-dir" });
    expect(c.IMAGE_DIR).toBe(`${homedir()}/custom-img-dir`);
  });

  test("respects MAX_IMAGE_BYTES override", () => {
    const c = readConsts({ TMUX_HUB_MAX_IMAGE_BYTES: String(50 * 1024 * 1024) });
    expect(c.MAX_IMAGE_BYTES).toBe(50 * 1024 * 1024);
  });
});
```

注意：用子进程 `bun -e` 跑导入避免 Bun 模块缓存影响 env 重载。

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `bun test tests/unit/image-dir.test.ts`
Expected: FAIL — `c.IMAGE_DIR` undefined（导出还没有）。

- [ ] **Step 3: 修改 config.ts**

Edit `src/server/config.ts`，在文件**末尾**（紧跟现有 `CAPTURE_PANE_LINES`）追加：

```ts
export const IMAGE_DIR = expandHome(
  process.env.TMUX_HUB_IMAGE_DIR ?? "~/Pictures/tmux-hub",
);
export const MAX_IMAGE_BYTES = Number(
  process.env.TMUX_HUB_MAX_IMAGE_BYTES ?? 20 * 1024 * 1024,
);
```

- [ ] **Step 4: 跑测试确认 PASS**

Run: `bun test tests/unit/image-dir.test.ts`
Expected: 4 个 case 全部 PASS

- [ ] **Step 5: 跑全套 unit + integration 确认无回归**

Run: `bun test tests/unit tests/integration`
Expected: 全 PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/config.ts tests/unit/image-dir.test.ts
git commit -m "feat(config): TMUX_HUB_IMAGE_DIR + TMUX_HUB_MAX_IMAGE_BYTES env constants"
```

---

## Task 5: 服务端 image-upload 纯逻辑（mime → ext、路径生成）

**目的**：把 mime 校验、ext 推断、路径拼接抽成纯函数，方便单元测；路由层再 wrap 这些函数。

**Files:**
- Create: `src/server/image-upload.ts`
- Test: `tests/unit/image-upload-logic.test.ts`

- [ ] **Step 1: 写失败的单元测试**

Create `tests/unit/image-upload-logic.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import {
  IMAGE_MIME_WHITELIST,
  extFromMime,
  imagePathFor,
  todayLocalDate,
} from "../../src/server/image-upload";

describe("IMAGE_MIME_WHITELIST", () => {
  test("contains the 5 expected types", () => {
    expect(new Set(IMAGE_MIME_WHITELIST)).toEqual(
      new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic"]),
    );
  });
});

describe("extFromMime", () => {
  test("known mime → matching ext", () => {
    expect(extFromMime("image/png")).toBe("png");
    expect(extFromMime("image/jpeg")).toBe("jpeg");
    expect(extFromMime("image/gif")).toBe("gif");
    expect(extFromMime("image/webp")).toBe("webp");
    expect(extFromMime("image/heic")).toBe("heic");
  });
  test("unknown mime → null", () => {
    expect(extFromMime("application/pdf")).toBeNull();
    expect(extFromMime("text/plain")).toBeNull();
    expect(extFromMime("")).toBeNull();
  });
});

describe("imagePathFor", () => {
  test("composes {root}/{date}/{uuid}.{ext}", () => {
    const p = imagePathFor("/var/img", "2026-05-23", "abc-123", "png");
    expect(p).toBe("/var/img/2026-05-23/abc-123.png");
  });
  test("never contains ..", () => {
    const p = imagePathFor("/var/img", "2026-05-23", crypto.randomUUID(), "jpeg");
    expect(p).not.toContain("..");
  });
});

describe("todayLocalDate", () => {
  test("returns YYYY-MM-DD format", () => {
    expect(todayLocalDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
```

- [ ] **Step 2: 跑测试确认 FAIL（模块不存在）**

Run: `bun test tests/unit/image-upload-logic.test.ts`
Expected: FAIL — `Cannot find module '../../src/server/image-upload'`

- [ ] **Step 3: 实现纯逻辑**

Create `src/server/image-upload.ts`:

```ts
export const IMAGE_MIME_WHITELIST = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/heic",
] as const;

export type ImageMime = (typeof IMAGE_MIME_WHITELIST)[number];

const MIME_TO_EXT: Record<ImageMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
};

export function extFromMime(mime: string): string | null {
  return (MIME_TO_EXT as Record<string, string>)[mime] ?? null;
}

export function imagePathFor(
  root: string,
  date: string,
  uuid: string,
  ext: string,
): string {
  return `${root}/${date}/${uuid}.${ext}`;
}

// Local-TZ YYYY-MM-DD. en-CA happens to format as ISO-8601 date.
export function todayLocalDate(): string {
  return new Date().toLocaleDateString("en-CA");
}
```

- [ ] **Step 4: 跑测试确认 PASS**

Run: `bun test tests/unit/image-upload-logic.test.ts`
Expected: 4 个 describe 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/image-upload.ts tests/unit/image-upload-logic.test.ts
git commit -m "feat(image-upload): pure helpers (mime whitelist, ext, path, local date)"
```

---

## Task 6: 服务端 image-upload Hono 路由 + 集成测试 + 接入 main

**目的**：在 `image-upload.ts` 内导出 `buildImageUploadRoutes()`，注册 `POST /sessions/:name/upload-image` 处理 multipart，落盘 + 返回绝对路径。集成测试用 Hono test client + 临时目录验证盘上文件。

**Files:**
- Modify: `src/server/image-upload.ts` (追加 route 部分)
- Modify: `src/server/main.ts:11, 73` 附近
- Test: `tests/integration/image-upload-route.test.ts`

- [ ] **Step 1: 写失败的集成测试**

Create `tests/integration/image-upload-route.test.ts`:

```ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildImageUploadRoutes } from "../../src/server/image-upload";

// Tiny valid PNG (1x1 red pixel) for fixture
const RED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

const SESSION = "user-iu-" + Date.now().toString().slice(-8);

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "tmux-hub-img-"));
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function makeApp() {
  const app = new Hono();
  app.route("/", buildImageUploadRoutes({ imageDir: tmpRoot, maxBytes: 1024 * 1024 }));
  return app;
}

function pngFile(name = "x.png"): File {
  const bytes = Buffer.from(RED_PNG_B64, "base64");
  return new File([bytes], name, { type: "image/png" });
}

function multipart(file: File): FormData {
  const fd = new FormData();
  fd.append("file", file);
  return fd;
}

describe("POST /sessions/:name/upload-image", () => {
  test("200 + path returned, file written on disk with correct bytes", async () => {
    const app = makeApp();
    const fd = multipart(pngFile());
    const r = await app.fetch(new Request(`http://localhost/sessions/${SESSION}/upload-image`, {
      method: "POST", body: fd,
    }));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; path: string };
    expect(body.ok).toBe(true);
    expect(body.path.startsWith(tmpRoot + "/")).toBe(true);
    expect(body.path.endsWith(".png")).toBe(true);
    const st = await stat(body.path);
    expect(st.isFile()).toBe(true);
    const written = await readFile(body.path);
    expect(written.byteLength).toBe(Buffer.from(RED_PNG_B64, "base64").byteLength);
  });

  test("two uploads of the same bytes produce two distinct UUIDs", async () => {
    const app = makeApp();
    const r1 = await app.fetch(new Request(`http://localhost/sessions/${SESSION}/upload-image`, {
      method: "POST", body: multipart(pngFile()),
    }));
    const r2 = await app.fetch(new Request(`http://localhost/sessions/${SESSION}/upload-image`, {
      method: "POST", body: multipart(pngFile()),
    }));
    const p1 = ((await r1.json()) as { path: string }).path;
    const p2 = ((await r2.json()) as { path: string }).path;
    expect(p1).not.toBe(p2);
  });

  test("rejects bad mime with 400", async () => {
    const app = makeApp();
    const badFile = new File([Buffer.from("hello")], "x.txt", { type: "text/plain" });
    const fd = multipart(badFile);
    const r = await app.fetch(new Request(`http://localhost/sessions/${SESSION}/upload-image`, {
      method: "POST", body: fd,
    }));
    expect(r.status).toBe(400);
  });

  test("rejects oversize body with 413", async () => {
    // 2-MB body vs 1-MB cap from makeApp()
    const big = new Uint8Array(2 * 1024 * 1024);
    const bigFile = new File([big], "big.png", { type: "image/png" });
    const app = makeApp();
    const r = await app.fetch(new Request(`http://localhost/sessions/${SESSION}/upload-image`, {
      method: "POST", body: multipart(bigFile),
    }));
    expect(r.status).toBe(413);
  });

  test("rejects bad session name grammar with 400", async () => {
    const app = makeApp();
    const r = await app.fetch(new Request(`http://localhost/sessions/Bad.Name/upload-image`, {
      method: "POST", body: multipart(pngFile()),
    }));
    expect(r.status).toBe(400);
  });

  test("rejects missing file part with 400", async () => {
    const app = makeApp();
    const r = await app.fetch(new Request(`http://localhost/sessions/${SESSION}/upload-image`, {
      method: "POST", body: new FormData(),
    }));
    expect(r.status).toBe(400);
  });
});
```

- [ ] **Step 2: 跑测试确认 FAIL（buildImageUploadRoutes 不存在）**

Run: `bun test tests/integration/image-upload-route.test.ts`
Expected: FAIL — import error

- [ ] **Step 3: 实现 route**

Append to `src/server/image-upload.ts`:

```ts
import { Hono } from "hono";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { isGrammarOk } from "../shared/session-name";

export type ImageUploadDeps = {
  imageDir: string;
  maxBytes: number;
};

export function buildImageUploadRoutes(deps: ImageUploadDeps): Hono {
  const r = new Hono();

  r.post("/sessions/:name/upload-image", async (c) => {
    const name = c.req.param("name");
    if (!isGrammarOk(name)) return c.json({ error: "session name grammar" }, 400);

    let parsed: Record<string, string | File>;
    try {
      parsed = (await c.req.parseBody()) as Record<string, string | File>;
    } catch {
      return c.json({ error: "invalid multipart body" }, 400);
    }
    const file = parsed.file;
    if (!(file instanceof File)) {
      return c.json({ error: "missing 'file' part" }, 400);
    }
    if (file.size === 0) {
      return c.json({ error: "empty file" }, 400);
    }
    if (file.size > deps.maxBytes) {
      return c.json({ error: "file too large" }, 413);
    }
    const ext = extFromMime(file.type);
    if (ext === null) {
      return c.json({ error: `unsupported content-type: ${file.type}` }, 400);
    }

    const date = todayLocalDate();
    const uuid = crypto.randomUUID();
    const absPath = imagePathFor(deps.imageDir, date, uuid, ext);

    try {
      await mkdir(dirname(absPath), { recursive: true });
      await Bun.write(absPath, file);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `write failed: ${msg}` }, 500);
    }
    return c.json({ ok: true, path: absPath });
  });

  return r;
}
```

注意：纯逻辑（`extFromMime` 等）在同文件，无需 import。

- [ ] **Step 4: 跑测试确认 PASS**

Run: `bun test tests/integration/image-upload-route.test.ts`
Expected: 6 个 case 全 PASS

如果 413 case 失败：原因可能是 Hono `parseBody()` 一次性读完才能判 size。当前测试用 2MB vs 1MB cap，差距小不会 OOM。生产 `MAX_IMAGE_BYTES = 20MB` 也在 RAM 可承载范围内。如果失败可改用 `c.req.raw.body` 流式但当前 YAGNI。

- [ ] **Step 5: 接入 main.ts**

Edit `src/server/main.ts`：

A. 修改 `import { loadTemplates, HUB_HOST, HUB_PORT, WINDOW_COLS, WINDOW_ROWS } from "./config";`（第 11 行）为：
```ts
import { loadTemplates, HUB_HOST, HUB_PORT, WINDOW_COLS, WINDOW_ROWS, IMAGE_DIR, MAX_IMAGE_BYTES } from "./config";
```

B. 顶部 import 区追加：
```ts
import { buildImageUploadRoutes } from "./image-upload";
```

C. 在 `app.route("/", buildSessionControlRoutes({ broadcasters }));`（第 73 行）的**下一行**追加：
```ts
app.route("/", buildImageUploadRoutes({ imageDir: IMAGE_DIR, maxBytes: MAX_IMAGE_BYTES }));
```

D. 在 `console.error(\`[tmux-hub] static dir ${WEB_DIST} ...\`)`（约第 125 行）的**下一行**追加：
```ts
console.error(`[tmux-hub] image dir: ${IMAGE_DIR}`);
```

- [ ] **Step 6: 跑 server 自检 — 启动 → 立即停**

Run:
```bash
TMUX_HUB_IMAGE_DIR=/tmp/tmux-hub-img-smoke TMUX_HUB_PORT=31099 timeout 2 bun run src/server/main.ts 2>&1 | grep -E "(listening|image dir)" || true
```

Expected: 输出
```
[tmux-hub] listening on http://127.0.0.1:31099
[tmux-hub] image dir: /tmp/tmux-hub-img-smoke
```

- [ ] **Step 7: 跑全套 unit + integration 确认无回归**

Run: `bun test tests/unit tests/integration`
Expected: 全 PASS

- [ ] **Step 8: Commit**

```bash
git add src/server/image-upload.ts src/server/main.ts tests/integration/image-upload-route.test.ts
git commit -m "feat(server): POST /sessions/:name/upload-image multipart route"
```

---

## Task 7: `deploy/hub.env.example` 追加 `TMUX_HUB_IMAGE_DIR`

**目的**：让 fork / 部署者一眼看到这个新 env 变量及其建议值。

**Files:**
- Modify: `deploy/hub.env.example`

- [ ] **Step 1: 追加注释行**

Edit `deploy/hub.env.example`，在文件末尾追加：

```bash

# 图片上传落盘根目录。建议指向数据盘，避免 ~ 空间紧张。
# 默认 $HOME/Pictures/tmux-hub
# TMUX_HUB_IMAGE_DIR=/Volumes/Data/tmux-hub-images

# 单次上传图片大小上限（字节）。默认 20MB。
# TMUX_HUB_MAX_IMAGE_BYTES=20971520
```

- [ ] **Step 2: Commit**

```bash
git add deploy/hub.env.example
git commit -m "docs(deploy): document TMUX_HUB_IMAGE_DIR + TMUX_HUB_MAX_IMAGE_BYTES env"
```

---

## Task 8: 前端共享 `upload/image-upload.ts`

**目的**：移动 / 桌面共用的上传逻辑：mime / 大小预检 + multipart POST + 错误规范化。

**Files:**
- Create: `src/web/upload/image-upload.ts`
- Test: `tests/unit/image-upload-client.test.ts`

- [ ] **Step 1: 写失败的单元测试**

Create `tests/unit/image-upload-client.test.ts`:

```ts
import { describe, test, expect, mock } from "bun:test";
import {
  IMAGE_MIME_WHITELIST_CLIENT,
  MAX_IMAGE_BYTES_CLIENT,
  isImageFile,
  uploadImageForSession,
} from "../../src/web/upload/image-upload";

describe("IMAGE_MIME_WHITELIST_CLIENT", () => {
  test("matches server-side whitelist", () => {
    expect(new Set(IMAGE_MIME_WHITELIST_CLIENT)).toEqual(
      new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic"]),
    );
  });
});

describe("isImageFile", () => {
  test("accepts whitelisted mimes", () => {
    for (const mime of IMAGE_MIME_WHITELIST_CLIENT) {
      const f = new File([new Uint8Array(1)], "x", { type: mime });
      expect(isImageFile(f)).toBe(true);
    }
  });
  test("rejects unknown mimes", () => {
    const f = new File([new Uint8Array(1)], "x.txt", { type: "text/plain" });
    expect(isImageFile(f)).toBe(false);
  });
});

describe("uploadImageForSession", () => {
  test("rejects oversized file without calling fetcher", async () => {
    const big = new File([new Uint8Array(MAX_IMAGE_BYTES_CLIENT + 1)], "big.png", { type: "image/png" });
    const fetcher = mock(async () => new Response("{}"));
    await expect(uploadImageForSession("s", big, fetcher)).rejects.toThrow(/too large/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("rejects bad mime without calling fetcher", async () => {
    const bad = new File([new Uint8Array(10)], "x.txt", { type: "text/plain" });
    const fetcher = mock(async () => new Response("{}"));
    await expect(uploadImageForSession("s", bad, fetcher)).rejects.toThrow(/unsupported/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("happy path: posts multipart + returns path", async () => {
    const file = new File([new Uint8Array(10)], "ok.png", { type: "image/png" });
    const fetcher = mock(async (input: string, init?: RequestInit) => {
      expect(input).toBe("/sessions/sess1/upload-image");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeInstanceOf(FormData);
      return new Response(JSON.stringify({ ok: true, path: "/abs/foo.png" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    const path = await uploadImageForSession("sess1", file, fetcher);
    expect(path).toBe("/abs/foo.png");
  });

  test("non-200 throws with body text", async () => {
    const file = new File([new Uint8Array(10)], "ok.png", { type: "image/png" });
    const fetcher = mock(async () => new Response("nope", { status: 413 }));
    await expect(uploadImageForSession("sess1", file, fetcher)).rejects.toThrow(/nope/);
  });
});
```

- [ ] **Step 2: 跑测试确认 FAIL（模块不存在）**

Run: `bun test tests/unit/image-upload-client.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现模块**

Create `src/web/upload/image-upload.ts`:

```ts
import { hubFetch } from "../hub-fetch";

export const IMAGE_MIME_WHITELIST_CLIENT = [
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/heic",
] as const;

export const MAX_IMAGE_BYTES_CLIENT = 20 * 1024 * 1024;

export const IMAGE_ACCEPT_ATTR =
  "image/png,image/jpeg,image/gif,image/webp,image/heic";

export function isImageFile(f: File | Blob): boolean {
  return (IMAGE_MIME_WHITELIST_CLIENT as readonly string[]).includes(f.type);
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export async function uploadImageForSession(
  session: string,
  file: File,
  fetcher: Fetcher = hubFetch,
): Promise<string> {
  if (file.size > MAX_IMAGE_BYTES_CLIENT) {
    throw new Error(
      `file too large: ${(file.size / 1024 / 1024).toFixed(1)}MB > ${MAX_IMAGE_BYTES_CLIENT / 1024 / 1024}MB cap`,
    );
  }
  if (!isImageFile(file)) {
    throw new Error(`unsupported mime: ${file.type || "(unknown)"}`);
  }
  const form = new FormData();
  form.append("file", file);
  const r = await fetcher(`/sessions/${encodeURIComponent(session)}/upload-image`, {
    method: "POST",
    body: form,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => `HTTP ${r.status}`);
    throw new Error(text || `HTTP ${r.status}`);
  }
  const body = (await r.json()) as { ok: boolean; path: string };
  return body.path;
}
```

- [ ] **Step 4: 跑测试确认 PASS**

Run: `bun test tests/unit/image-upload-client.test.ts`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/upload/image-upload.ts tests/unit/image-upload-client.test.ts
git commit -m "feat(upload): shared client module for image upload (predicate + multipart POST)"
```

---

## Task 9: 移动端 `image-attach.ts` 按钮 + 接入 mobile-view

**目的**：在 mobile 工具栏 `🚀 quick-launch` **右侧** 加 📎 按钮；点击→选图→上传→把路径插到 drawer textarea + 自动开 drawer + focus。

**Files:**
- Create: `src/web/mobile/image-attach.ts`
- Create: `tests/e2e/fixtures/red.png`
- Modify: `src/web/mobile/mobile-view.ts:184` 附近
- Test: `tests/e2e/mobile.e2e.ts` (追加 case)

- [ ] **Step 1: 生成 PNG fixture**

Run:
```bash
cd /Volumes/Data/code/self/tmux-hub/.claude/worktrees/feat-mobile-fixes-r2 && mkdir -p tests/e2e/fixtures && echo "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==" | base64 -d > tests/e2e/fixtures/red.png && ls -l tests/e2e/fixtures/red.png
```
Expected: 创建了 `tests/e2e/fixtures/red.png`，大小 ~70 字节。

- [ ] **Step 2: 写失败的 E2E**

Append to `tests/e2e/mobile.e2e.ts`（如果文件没 import `join` 就在顶部加 `import { join } from "node:path";`）：

```ts
test("image attach: picker → upload → drawer opens + path appears in textarea", async ({ page, ctx }) => {
  const name = uniqSession("shell");
  ctx.tmuxE2E(["new-session", "-d", "-s", name, "sh"]);

  await page.goto("/");
  await bindSecret(page);
  await page.reload();

  await expect(page.locator(`.mobile-shell__session-select option[value="${name}"]`))
    .toHaveCount(1, { timeout: 10_000 });
  await page.locator(".mobile-shell__session-select").selectOption({ label: name });
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
```

- [ ] **Step 3: 跑 E2E 确认 FAIL**

Run: `bunx playwright test tests/e2e/mobile.e2e.ts -g "image attach"`
Expected: FAIL — `.mobile-toolbar__image-attach-input` 找不到。

- [ ] **Step 4: 实现 image-attach.ts**

Create `src/web/mobile/image-attach.ts`:

```ts
import { uploadImageForSession, IMAGE_ACCEPT_ATTR } from "../upload/image-upload";
import { showToast } from "../ui/toast";

export type ImageAttachDeps = {
  parent: HTMLElement;
  getSession: () => string | null;
  getTextarea: () => HTMLTextAreaElement | null;
  openDrawer: () => void;
};

export function renderImageAttachButton(deps: ImageAttachDeps): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mobile-toolbar__image-attach";
  btn.setAttribute("aria-label", "上传图片");
  btn.textContent = "📎";

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = IMAGE_ACCEPT_ATTR;
  fileInput.className = "mobile-toolbar__image-attach-input";
  fileInput.style.display = "none";

  deps.parent.append(btn, fileInput);

  const doUpload = async (session: string, file: File): Promise<void> => {
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = "...";
    try {
      const path = await uploadImageForSession(session, file);
      deps.openDrawer();
      const ta = deps.getTextarea();
      if (ta) {
        const before = ta.value.slice(0, ta.selectionStart ?? ta.value.length);
        const after = ta.value.slice(ta.selectionEnd ?? ta.value.length);
        const inserted = ` ${path} `;
        ta.value = before + inserted + after;
        const caret = before.length + inserted.length;
        ta.setSelectionRange(caret, caret);
        ta.focus();
      }
    } catch (e) {
      showToast(`上传失败：${(e as Error).message}`, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  };

  btn.addEventListener("click", () => {
    const session = deps.getSession();
    if (!session) {
      showToast("先选一个 session", "error");
      return;
    }
    fileInput.value = ""; // allow re-picking the same file
    fileInput.click();
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const session = deps.getSession();
    if (!session) {
      showToast("session 已断开", "error");
      return;
    }
    void doUpload(session, file);
  });

  return btn;
}
```

- [ ] **Step 5: 接入 mobile-view.ts**

Edit `src/web/mobile/mobile-view.ts`：

A. 顶部 import 追加：
```ts
import { renderImageAttachButton } from "./image-attach";
```

B. 找到 `renderQuickLaunchButton({ parent: toolbar, onStarted: ... });` 调用块（约 184-203 行）。在其结束 `});` 的**下一行**、`renderSpecialKeysBar(toolbar, send);` 的**上一行**插入：

```ts
renderImageAttachButton({
  parent: toolbar,
  getSession: () => openedName,
  getTextarea: () => drawer.querySelector<HTMLTextAreaElement>(".mobile-input__textarea"),
  openDrawer: () => setDrawer(true),
});
```

注意：`openedName`、`drawer`、`setDrawer` 都在同一函数闭包内，直接闭包引用。DOM 顺序为 `✎ toggle | 🚀 quick-launch | 📎 attach | 特殊键栏`。

- [ ] **Step 6: 跑 E2E 确认 PASS**

Run: `bunx playwright test tests/e2e/mobile.e2e.ts -g "image attach"`
Expected: PASS

- [ ] **Step 7: 跑全 mobile e2e 确认无回归**

Run: `bunx playwright test tests/e2e/mobile.e2e.ts`
Expected: 全 PASS

- [ ] **Step 8: Commit**

```bash
git add src/web/mobile/image-attach.ts src/web/mobile/mobile-view.ts tests/e2e/mobile.e2e.ts tests/e2e/fixtures/red.png
git commit -m "feat(mobile): 📎 image attach button — picker → upload → inject path into drawer textarea"
```

---

## Task 10: 桌面端 session header 📎 按钮

**目的**：在 desktop session header 加 📎 按钮；上传成功后通过 `term.send({kind:"keys", literal: " " + path + " "})` 直接注入到当前 attach 的 tmux session。

**Files:**
- Modify: `src/web/desktop/desktop-view.ts:27-77` 区域
- Test: `tests/e2e/desktop.e2e.ts`

- [ ] **Step 1: 检查 desktop.e2e.ts 文件头**

Run:
```bash
head -5 /Volumes/Data/code/self/tmux-hub/.claude/worktrees/feat-mobile-fixes-r2/tests/e2e/desktop.e2e.ts
```
Expected: 看到 import 列表，确认是否已经 import 了 `join` 和 `bindSecret/uniqSession`。

- [ ] **Step 2: 写失败的 E2E**

Append to `tests/e2e/desktop.e2e.ts`（必要时在顶部追加 `import { join } from "node:path";`）：

```ts
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
```

- [ ] **Step 3: 跑 E2E 确认 FAIL**

Run: `bunx playwright test tests/e2e/desktop.e2e.ts -g "image attach"`
Expected: FAIL — `.session-header__image-attach-input` 找不到。

- [ ] **Step 4: 实现 header 改动**

Edit `src/web/desktop/desktop-view.ts`：

A. 顶部 import 追加（如果还没有 `showToast` 的 import 已经存在，只追加 upload 行）：
```ts
import { uploadImageForSession, IMAGE_ACCEPT_ATTR } from "../upload/image-upload";
```

B. 在 `let term: TerminalHandle | null = null;`（约 27 行）的**下一行**追加：
```ts
let currentSession: string | null = null;
```
（Task 11 paste handler 也会用到，这里先建好。）

C. 在 `open` 函数体最前面（`if (term) { term.close(); term = null; }` **之前**）追加：
```ts
currentSession = name;
```

D. 在 `const header = document.createElement("header");` 后、`header.append(nameEl, killBtn, refreshBtn, detachBtn);` **之前**追加（注意：原 `header.append` 行约 41 行）：

```ts
const attachBtn = button("📎", "session-header__image-attach");
attachBtn.setAttribute("aria-label", "上传图片");
const attachInput = document.createElement("input");
attachInput.type = "file";
attachInput.accept = IMAGE_ACCEPT_ATTR;
attachInput.className = "session-header__image-attach-input";
attachInput.style.display = "none";
```

E. 把 `header.append(nameEl, killBtn, refreshBtn, detachBtn);` 替换为：
```ts
header.append(nameEl, attachBtn, attachInput, killBtn, refreshBtn, detachBtn);
```

F. 在 `detachBtn.addEventListener(...)` 整个块（约 74-77 行）的 `});` **后**追加：

```ts
attachBtn.addEventListener("click", () => {
  attachInput.value = "";
  attachInput.click();
});
attachInput.addEventListener("change", async () => {
  const file = attachInput.files?.[0];
  if (!file) return;
  attachBtn.disabled = true;
  const original = attachBtn.textContent;
  attachBtn.textContent = "...";
  try {
    const path = await uploadImageForSession(name, file);
    term?.send({ kind: "keys", literal: " " + path + " " });
  } catch (e) {
    showToast(`上传失败：${(e as Error).message}`, "error");
  } finally {
    attachBtn.disabled = false;
    attachBtn.textContent = original;
  }
});
```

注意：`name` 来自外层 `open(name)` 闭包；`term` 也是外层闭包变量。

- [ ] **Step 5: 跑 E2E 确认 PASS**

Run: `bunx playwright test tests/e2e/desktop.e2e.ts -g "image attach"`
Expected: PASS

- [ ] **Step 6: 跑全 desktop e2e 确认无回归**

Run: `bunx playwright test tests/e2e/desktop.e2e.ts`
Expected: 全 PASS

- [ ] **Step 7: Commit**

```bash
git add src/web/desktop/desktop-view.ts tests/e2e/desktop.e2e.ts
git commit -m "feat(desktop): 📎 image attach in session header — direct send-keys path injection"
```

---

## Task 11: 桌面端剪贴板粘贴拦截

**目的**：在 desktop `right`（main）容器上监听 `paste`，剪贴板含 image item → preventDefault + 上传 + 注入；纯文本 → 不拦截，让 xterm textarea-helper 处理。

**Files:**
- Modify: `src/web/desktop/desktop-view.ts`（追加 paste 监听）
- Test: `tests/e2e/desktop.e2e.ts`

- [ ] **Step 1: 写失败的 E2E**

Append to `tests/e2e/desktop.e2e.ts`:

```ts
test("desktop clipboard paste: image item intercepted + path injected", async ({ page, ctx }) => {
  const name = uniqSession("shell");
  ctx.tmuxE2E(["new-session", "-d", "-s", name, "-x", "120", "-y", "40", "sh"]);

  await page.goto("/");
  await bindSecret(page);
  await page.reload();

  await page.locator(`.session-list__item[data-session-name="${name}"]`).click();
  await page.waitForTimeout(800);

  // Synthesize a paste event with an image item on the main region.
  const RED_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
  await page.evaluate((b64: string) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], "clip.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector(".desktop-shell__main")!.dispatchEvent(ev);
  }, RED_PNG_B64);

  await page.waitForTimeout(800);
  const captured = ctx.tmuxE2E(["capture-pane", "-p", "-t", name]);
  expect(captured).toMatch(/[\/\w-]+\.png/);

  ctx.tmuxE2E(["kill-session", "-t", name]);
});
```

- [ ] **Step 2: 跑 E2E 确认 FAIL（粘贴没监听）**

Run: `bunx playwright test tests/e2e/desktop.e2e.ts -g "clipboard paste"`
Expected: FAIL

- [ ] **Step 3: 实现 paste 监听**

Edit `src/web/desktop/desktop-view.ts`，在 `list.onSelect((name) => { void open(name); });`（约 80 行）的**上一行**追加：

```ts
// Image-paste interception. Listen on the main region so the event has time
// to bubble up from xterm's textarea helper. Only preventDefault when we
// actually find an image item; pure-text pastes pass through to xterm.
right.addEventListener("paste", (e) => {
  const items = (e as ClipboardEvent).clipboardData?.items;
  if (!items) return;
  const imageItem = Array.from(items).find((it) => it.type.startsWith("image/"));
  if (!imageItem) return;
  e.preventDefault();
  e.stopPropagation();
  const file = imageItem.getAsFile();
  if (!file || !currentSession) return;
  void (async () => {
    try {
      const path = await uploadImageForSession(currentSession!, file);
      term?.send({ kind: "keys", literal: " " + path + " " });
    } catch (err) {
      showToast(`上传失败：${(err as Error).message}`, "error");
    }
  })();
});
```

`currentSession`、`term`、`uploadImageForSession`、`showToast` 都在 Task 10 中已就绪。

- [ ] **Step 4: 跑 E2E 确认 PASS**

Run: `bunx playwright test tests/e2e/desktop.e2e.ts -g "clipboard paste"`
Expected: PASS

- [ ] **Step 5: 跑全 desktop e2e 确认无回归（rename / kill 不被 paste 误伤）**

Run: `bunx playwright test tests/e2e/desktop.e2e.ts`
Expected: 全 PASS

- [ ] **Step 6: Commit**

```bash
git add src/web/desktop/desktop-view.ts tests/e2e/desktop.e2e.ts
git commit -m "feat(desktop): clipboard image paste → upload → inject path; text paste passes through"
```

---

## Task 12: CSS — rename 编辑态 + attach 按钮样式

**目的**：让新增的 UI 元素视觉上不错位：mobile rename 的 input/保存/取消按钮排得整齐；mobile/desktop 的 📎 按钮风格与现有按钮一致。

**Files:**
- Modify: `src/web/style.css`

- [ ] **Step 1: 追加新规则到 style.css 末尾**

Append to `src/web/style.css`:

```css
/* --- Mobile: rename mode in header --- */
.mobile-shell__rename {
  flex: 0 0 auto;
  padding: 0 .5rem;
  font-size: 1rem;
  background: transparent;
  border: 1px solid currentColor;
  border-radius: .25rem;
  color: inherit;
  cursor: pointer;
}
.mobile-shell__rename-input {
  flex: 1 1 auto;
  min-width: 0;
  font: inherit;
  padding: .25rem .5rem;
}
.mobile-shell__rename-save,
.mobile-shell__rename-cancel {
  flex: 0 0 auto;
  padding: 0 .5rem;
  font-size: .9rem;
}

/* --- Mobile: image attach button in toolbar --- */
.mobile-toolbar__image-attach {
  flex: 0 0 auto;
  padding: 0 .5rem;
  font-size: 1.1rem;
  background: transparent;
  border: 1px solid currentColor;
  border-radius: .25rem;
  color: inherit;
  cursor: pointer;
}
.mobile-toolbar__image-attach:disabled {
  opacity: .5;
  cursor: progress;
}

/* --- Desktop: image attach in session header --- */
.session-header__image-attach {
  margin-left: .5rem;
}
.session-header__image-attach:disabled {
  opacity: .5;
  cursor: progress;
}
```

- [ ] **Step 2: 构建确认 CSS 正确**

Run: `bun run build:web`
Expected: 构建成功。

- [ ] **Step 3: Commit**

```bash
git add src/web/style.css
git commit -m "style(ui): mobile rename edit mode + mobile/desktop image attach buttons"
```

人工视觉验证（不卡 plan 自动化）：开 `bun run dev` → 移动 viewport（Chrome DevTools → iPhone 14 Pro）看 rename 编辑模式 + 📎 按钮；桌面看 session header 📎 与 kill/refresh 排布。

---

## Task 13: 最终 sweep + PR 描述更新 + 切 ready

**目的**：跑一次全 test suite 兜底；把测试结果填进 PR；从 Draft 切到 Ready。

- [ ] **Step 1: 跑全部 unit + integration**

Run: `bun test`
Expected: 全 PASS

- [ ] **Step 2: 跑全部 e2e**

Run: `bun run test:e2e`
Expected: 全 PASS（包括 mobile rename / empty-submit / image attach + desktop image attach / paste 新增测试）

如果 PWA e2e 依赖单独 `--project=pwa` 标志，单独跑：
```bash
bunx playwright test --project=pwa
```

- [ ] **Step 3: 检查 git log 提交链路**

Run: `git log --oneline origin/main..HEAD`
Expected: 看到 ~12 条 commit，按 Task 顺序原子排列。

- [ ] **Step 4: 更新 PR 描述**

Run:
```bash
gh pr edit 6 --body "$(cat <<'EOF'
## Summary
- 移动端 session rename：✎ 编辑模式（保存 / 取消按钮），复用 `POST /sessions/:name/rename`；桌面端逻辑抽到 `src/web/shared/rename-controller.ts`
- 空 textarea 提交 = 纯回车：移动端输入箱去掉空文本守卫
- 图片上传（前后端）：
  - 新 HTTP 路由 `POST /sessions/:name/upload-image`（multipart）
  - 新 env `TMUX_HUB_IMAGE_DIR`（默认 `~/Pictures/tmux-hub`，生产指向数据盘）
  - 新 env `TMUX_HUB_MAX_IMAGE_BYTES`（默认 20MB）
  - 前端共享 `src/web/upload/image-upload.ts`
  - 移动端 📎 → 选图 → 注入 drawer textarea
  - 桌面端 📎 → 选图 → 直发到 tmux pane；剪贴板含图 → 拦截 + 上传 + 直发

## Test plan
- [x] `bun test` 全绿
- [x] `bun run test:e2e` 全绿
- [ ] 真机 iOS Safari：rename / 空提交 Enter / 拍照上传 / 相册上传
- [ ] 桌面 Chrome：rename / paste 截图 / 按钮上传
- [ ] claude-code 内：注入路径是否被识别为图片附件

## 部署
在 `~/.config/tmux-hub/hub.env` 设置：
```
TMUX_HUB_IMAGE_DIR=/Volumes/Data/tmux-hub-images
```
`~/Pictures/tmux-hub` 默认 fallback 让 fork 可以一键 `bun run dev`。

Spec: `docs/superpowers/specs/2026-05-23-mobile-fixes-r2-design.md`
Plan: `docs/superpowers/plans/2026-05-23-mobile-fixes-r2.md`
EOF
)"
gh pr ready 6
```

- [ ] **Step 5: 最后 push**

Run: `git push`
Expected: `Everything up-to-date` 或新 commit 上去

---

## 实施完成判定

- ✅ 13 个 Task 全部勾完
- ✅ `bun test` 全绿
- ✅ `bun run test:e2e` 全绿
- ✅ PR #6 切到 Ready 状态
- ⏳ 人工真机验证（不在 plan 自动化范围；PR 描述里勾）

完成后，把"真机验证 + claude-code 实际识别图片附件"两条作为 PR review 阶段的人工 acceptance criterion。
