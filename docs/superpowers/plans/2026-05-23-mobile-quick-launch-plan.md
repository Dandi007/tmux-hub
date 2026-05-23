# Mobile Quick-Launch 按钮 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 tmux-hub 移动端 toolbar 加一个固定按钮，点击后通过现有 `POST /templates/:id/run` 通道，用契约 id `kb-cc` 起一个新 tmux session（cwd / cmd 来自用户机器 templates.yaml 配置），前端自动切到该 session。

**Architecture:** 后端 0 改动；前端在 `src/web/mobile/` 新增一个 quick-launch 模块（包含 pure async helper + render 函数），mount 时一次性 GET `/templates` 缓存 `kb-cc` 的 `cwd_choices[0]`，按钮点击后 POST 携带 cached cwd。helper 走 TDD 单测；按钮 DOM 与端到端流程由 Playwright e2e 在 mobile project 覆盖。

**Tech Stack:** TypeScript, Bun test (无 DOM), Vite, Hono (server，不改), xterm.js (不改), Playwright (iPhone 14 emulation)。仓库已配 `@shared` alias → `src/shared`。

**Spec:** `docs/superpowers/specs/2026-05-23-mobile-quick-launch-design.md`

---

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/shared/protocol.ts` | modify | 追加 `MOBILE_QUICK_LAUNCH_TEMPLATE_ID = "kb-cc"` 常量 |
| `src/web/mobile/quick-launch.ts` | create | (a) pure helper `runQuickLaunch`：调 POST、按状态码分支；(b) `renderQuickLaunchButton`：挂按钮、mount 时拉 cwd、点击时调 helper |
| `src/web/mobile/mobile-view.ts` | modify | 在 toolbar 上 `✎` 右、`renderSpecialKeysBar` 左，挂 quick-launch 按钮；回调走现有 `openSession()` |
| `src/web/style.css` | modify | 新 class `.mobile-toolbar__quick-launch` 的尺寸 / disabled 样式 |
| `deploy/templates.yaml.example` | modify | 加 `kb-cc` 占位 entry（cwd `~`、cmd `sh`），注释说明用户拷贝时改成知识库路径 + `cc -f` |
| `tests/unit/quick-launch.test.ts` | create | pure helper 的 200 / 404 / 500 / 网络错误单测 |
| `tests/e2e/mobile.e2e.ts` | modify | append happy-path e2e：点按钮 → tmux 出现新 session → 移动端 select 切到该 session |

**File responsibility 边界：**
- `quick-launch.ts` 内部分成 pure helper（无 DOM、无网络耦合，依赖注入 fetcher）和 thin render 函数（DOM + wiring），便于单测纯逻辑、e2e 覆盖 wiring。
- `mobile-view.ts` 只负责把按钮挂到 toolbar，不写按钮内部逻辑。
- 不改 playwright.config.ts，复用现有 `TMUX_HUB_TEMPLATES_PATH=deploy/templates.yaml.example` 配置——这就是为什么 example 必须加 active `kb-cc` entry。

---

## Tasks

### Task 1: 加 `MOBILE_QUICK_LAUNCH_TEMPLATE_ID` 常量

**Files:**
- Modify: `src/shared/protocol.ts`（追加，末尾）

- [ ] **Step 1: 在 `src/shared/protocol.ts` 末尾追加常量**

```ts
/**
 * 移动端 quick-launch 按钮硬编码调用的 template id。
 * 用户机器 ~/.config/tmux-hub/templates.yaml 必须存在这条 template，
 * 否则 mount 时 /templates 列表里找不到、按钮 disabled。
 */
export const MOBILE_QUICK_LAUNCH_TEMPLATE_ID = "kb-cc";
```

- [ ] **Step 2: TS 类型检查**

Run: `cd /Volumes/Data/code/self/tmux-hub/.claude/worktrees/feat-mobile-quick-launch && bun build src/shared/protocol.ts --target=browser --outfile=/dev/null 2>&1 | head`

Expected: 无错误输出（exit 0）。

- [ ] **Step 3: Commit**

```bash
cd /Volumes/Data/code/self/tmux-hub/.claude/worktrees/feat-mobile-quick-launch
git add src/shared/protocol.ts
git commit -m "feat(shared): add MOBILE_QUICK_LAUNCH_TEMPLATE_ID contract constant"
```

---

### Task 2: `deploy/templates.yaml.example` 加 `kb-cc` 占位 entry

**Files:**
- Modify: `deploy/templates.yaml.example`

为什么必须是 active entry 而不是注释：`playwright.config.ts` 的 webServer 直接用此文件作为 e2e hub 的 `TMUX_HUB_TEMPLATES_PATH`。若注释掉，e2e 找不到 kb-cc。

- [ ] **Step 1: 覆写 `deploy/templates.yaml.example`**

```yaml
templates:
  # Minimal default: one button → new zsh in $HOME. User can cd and run
  # any command from inside the session. Add more templates here if useful.
  - id: shell
    name: "新建 zsh"
    cwd_choices: ["~"]
    cmd: "zsh"

  # Mobile quick-launch contract. id MUST match MOBILE_QUICK_LAUNCH_TEMPLATE_ID
  # exported from src/shared/protocol.ts. When you copy this file to
  # ~/.config/tmux-hub/templates.yaml, change cwd_choices to your knowledge-base
  # absolute path and cmd to `cc -f` (or `zsh -ic 'cc -f; exec zsh'` if you want
  # to keep the shell alive after Claude Code exits).
  - id: kb-cc
    name: "知识库 cc"
    cwd_choices: ["~"]
    cmd: "sh"
```

- [ ] **Step 2: 验证 YAML 解析通过现有 zod schema**

Run: `cd /Volumes/Data/code/self/tmux-hub/.claude/worktrees/feat-mobile-quick-launch && bun test tests/unit/templates-schema.test.ts 2>&1 | tail -5`

Expected: 全部 pass。若 schema test 不直接读 example，则手动检查：

```bash
bun -e 'import("./src/server/config.ts").then(m => console.log(m.parseTemplatesYaml(require("node:fs").readFileSync("deploy/templates.yaml.example", "utf8"))))'
```

Expected stdout: 两条 template 数组，没有抛错。

- [ ] **Step 3: Commit**

```bash
git add deploy/templates.yaml.example
git commit -m "chore(deploy): add kb-cc placeholder template to example config"
```

---

### Task 3: 写 pure helper 的第一个失败测试（200 OK 路径）

**Files:**
- Create: `tests/unit/quick-launch.test.ts`

- [ ] **Step 1: 创建测试文件，写 200 OK 路径**

```ts
import { describe, test, expect, mock } from "bun:test";
import { runQuickLaunch } from "../../src/web/mobile/quick-launch";

describe("runQuickLaunch", () => {
  test("200 OK → onStarted called with returned name; no error callback", async () => {
    const fetcher = mock(async () => new Response(JSON.stringify({ name: "kb-cc-20260523010000" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const onStarted = mock(() => {});
    const onError = mock(() => {});

    await runQuickLaunch({ fetcher, cwd: "~", onStarted, onError });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/templates/kb-cc/run");
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ cwd: "~" }));
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(onStarted.mock.calls[0]?.[0]).toBe("kb-cc-20260523010000");
    expect(onError).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认 fail**

Run: `cd /Volumes/Data/code/self/tmux-hub/.claude/worktrees/feat-mobile-quick-launch && bun test tests/unit/quick-launch.test.ts 2>&1 | tail`

Expected: FAIL，错误大致是 "Cannot find module '../../src/web/mobile/quick-launch'"。

- [ ] **Step 3: 不 commit**（red 阶段，等绿了一起 commit）

---

### Task 4: 写最小实现让 Task 3 测试通过

**Files:**
- Create: `src/web/mobile/quick-launch.ts`

- [ ] **Step 1: 创建 helper 模块（含 runQuickLaunch 纯函数）**

```ts
import { MOBILE_QUICK_LAUNCH_TEMPLATE_ID } from "@shared/protocol";

export type QuickLaunchFetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type RunQuickLaunchOpts = {
  fetcher: QuickLaunchFetcher;
  cwd: string;
  onStarted: (name: string) => void;
  onError: (kind: "not-configured" | "runtime", message: string) => void;
};

/**
 * Pure async helper: POST /templates/{kb-cc}/run with the cached cwd.
 *
 * The render layer is responsible for:
 *   - resolving cwd at mount time from GET /templates
 *   - guarding button disabled state during the in-flight POST
 *
 * Splitting the responsibilities like this keeps the network-shape testable
 * without bringing a DOM into bun:test (the repo intentionally does not pull
 * in happy-dom / jsdom — the e2e suite covers the wiring).
 */
export async function runQuickLaunch(opts: RunQuickLaunchOpts): Promise<void> {
  const { fetcher, cwd, onStarted, onError } = opts;
  const path = `/templates/${encodeURIComponent(MOBILE_QUICK_LAUNCH_TEMPLATE_ID)}/run`;
  let res: Response;
  try {
    res = await fetcher(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
  } catch (e) {
    onError("runtime", e instanceof Error ? e.message : String(e));
    return;
  }
  if (res.status === 404) {
    onError("not-configured", `template '${MOBILE_QUICK_LAUNCH_TEMPLATE_ID}' not configured`);
    return;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => `HTTP ${res.status}`);
    onError("runtime", text || `HTTP ${res.status}`);
    return;
  }
  const body = (await res.json().catch(() => null)) as { name?: string } | null;
  if (!body || typeof body.name !== "string") {
    onError("runtime", "malformed response");
    return;
  }
  onStarted(body.name);
}
```

- [ ] **Step 2: 跑测试确认 pass**

Run: `bun test tests/unit/quick-launch.test.ts 2>&1 | tail`

Expected: `1 pass`，0 fail。

- [ ] **Step 3: Commit（红→绿，test + impl 一起）**

```bash
git add src/web/mobile/quick-launch.ts tests/unit/quick-launch.test.ts
git commit -m "feat(mobile): add runQuickLaunch pure helper with 200 OK path"
```

---

### Task 5: 加 404 路径测试

helper 已经实现了 404 分支，本任务补测试覆盖 + 防止 contract 漂移。

**Files:**
- Modify: `tests/unit/quick-launch.test.ts`（append test）

- [ ] **Step 1: 在 describe block 内追加 404 测试**

```ts
  test("404 → onError('not-configured'); no onStarted", async () => {
    const fetcher = mock(async () => new Response("template not found: kb-cc", { status: 404 }));
    const onStarted = mock(() => {});
    const onError = mock(() => {});

    await runQuickLaunch({ fetcher, cwd: "~", onStarted, onError });

    expect(onStarted).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe("not-configured");
    expect(onError.mock.calls[0]?.[1]).toContain("kb-cc");
  });
```

- [ ] **Step 2: 跑测试确认 pass**

Run: `bun test tests/unit/quick-launch.test.ts 2>&1 | tail`

Expected: `2 pass`，0 fail。

- [ ] **Step 3: Commit**

```bash
git add tests/unit/quick-launch.test.ts
git commit -m "test(mobile): cover 404 not-configured branch of runQuickLaunch"
```

---

### Task 6: 加 500 / 网络错误 / 畸形响应测试

**Files:**
- Modify: `tests/unit/quick-launch.test.ts`（append 3 tests）

- [ ] **Step 1: 在 describe block 内追加 3 个错误测试**

```ts
  test("500 → onError('runtime', body text)", async () => {
    const fetcher = mock(async () => new Response("internal boom", { status: 500 }));
    const onStarted = mock(() => {});
    const onError = mock(() => {});

    await runQuickLaunch({ fetcher, cwd: "~", onStarted, onError });

    expect(onStarted).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe("runtime");
    expect(onError.mock.calls[0]?.[1]).toBe("internal boom");
  });

  test("network error (fetcher throws) → onError('runtime', message)", async () => {
    const fetcher = mock(async () => { throw new Error("network down"); });
    const onStarted = mock(() => {});
    const onError = mock(() => {});

    await runQuickLaunch({ fetcher, cwd: "~", onStarted, onError });

    expect(onStarted).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe("runtime");
    expect(onError.mock.calls[0]?.[1]).toBe("network down");
  });

  test("200 with malformed body → onError('runtime', 'malformed response')", async () => {
    const fetcher = mock(async () => new Response("<not-json>", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const onStarted = mock(() => {});
    const onError = mock(() => {});

    await runQuickLaunch({ fetcher, cwd: "~", onStarted, onError });

    expect(onStarted).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe("runtime");
    expect(onError.mock.calls[0]?.[1]).toBe("malformed response");
  });
```

- [ ] **Step 2: 跑测试确认 pass**

Run: `bun test tests/unit/quick-launch.test.ts 2>&1 | tail`

Expected: `5 pass`，0 fail。

- [ ] **Step 3: Commit**

```bash
git add tests/unit/quick-launch.test.ts
git commit -m "test(mobile): cover runtime error / network / malformed branches"
```

---

### Task 7: 在 `quick-launch.ts` 加 `renderQuickLaunchButton` 渲染函数

**Files:**
- Modify: `src/web/mobile/quick-launch.ts`（append 渲染函数）

DOM 渲染部分由 e2e 覆盖（仓库 Bun test 不带 DOM）。本任务只加代码，不写单测。

- [ ] **Step 1: 在 `quick-launch.ts` 末尾追加 render 函数与新 import**

把文件顶部的 import 行替换 / 扩展为：

```ts
import { MOBILE_QUICK_LAUNCH_TEMPLATE_ID } from "@shared/protocol";
import { hubFetch } from "../hub-fetch";
import { showToast } from "../ui/toast";
```

然后在文件末尾追加：

```ts
type TemplateListItem = { id: string; name: string; cwd_choices: string[] };

export type QuickLaunchButtonOpts = {
  parent: HTMLElement;
  onStarted: (name: string) => void;
};

/**
 * Mount the mobile toolbar's quick-launch button. mount-time pulls the
 * configured cwd for kb-cc; if absent, the button is permanently disabled.
 */
export function renderQuickLaunchButton(opts: QuickLaunchButtonOpts): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mobile-toolbar__quick-launch";
  btn.textContent = "+";
  btn.setAttribute("aria-label", "新建知识库 Claude Code 会话");
  btn.disabled = true;
  btn.title = "加载中…";
  opts.parent.appendChild(btn);

  let cachedCwd: string | null = null;

  void hubFetch("/templates")
    .then((r) => r.ok ? r.json() as Promise<TemplateListItem[]> : Promise.reject(new Error(`HTTP ${r.status}`)))
    .then((list) => {
      const found = list.find((t) => t.id === MOBILE_QUICK_LAUNCH_TEMPLATE_ID);
      if (!found || found.cwd_choices.length === 0) {
        btn.disabled = true;
        btn.title = `未配置快速启动模板（id: ${MOBILE_QUICK_LAUNCH_TEMPLATE_ID}）`;
        return;
      }
      cachedCwd = found.cwd_choices[0] ?? null;
      btn.disabled = false;
      btn.title = `新建会话：${found.name}`;
    })
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      btn.disabled = true;
      btn.title = `模板加载失败：${msg}`;
    });

  btn.addEventListener("click", () => {
    if (btn.disabled || cachedCwd === null) return;
    btn.disabled = true;
    void runQuickLaunch({
      fetcher: hubFetch,
      cwd: cachedCwd,
      onStarted: (name) => {
        btn.disabled = false;
        opts.onStarted(name);
      },
      onError: (kind, message) => {
        btn.disabled = false;
        if (kind === "not-configured") {
          showToast(`未配置快速启动模板：在 ~/.config/tmux-hub/templates.yaml 添加 id: ${MOBILE_QUICK_LAUNCH_TEMPLATE_ID}`, "error");
        } else {
          showToast(`启动失败：${message}`, "error");
        }
      },
    });
  });

  return btn;
}
```

- [ ] **Step 2: 跑全套单测确认没回归**

Run: `bun test 2>&1 | tail -5`

Expected: 全过（既有 + 5 新增），0 fail。

- [ ] **Step 3: 跑 vite build 验证 TS 编译过**

Run: `bun run build:web 2>&1 | tail -10`

Expected: build 成功（"built in Xms"），无 TS error。

- [ ] **Step 4: Commit**

```bash
git add src/web/mobile/quick-launch.ts
git commit -m "feat(mobile): add renderQuickLaunchButton with mount-time cwd resolution"
```

---

### Task 8: 把按钮挂到 `mobile-view.ts` 的 toolbar

**Files:**
- Modify: `src/web/mobile/mobile-view.ts`

- [ ] **Step 1: 在文件顶部 import 区追加**

找到现有的 import 块（约 1-7 行），在 `renderSpecialKeysBar` import 后面追加：

```ts
import { renderQuickLaunchButton } from "./quick-launch";
```

- [ ] **Step 2: 找到 toolbar 区域，在 toggleBtn 挂载 + drawer wiring 之后、`renderSpecialKeysBar(toolbar, send);` 之前插入 quick-launch 挂载**

定位锚点：现在 `mobile-view.ts` 末尾附近大致是这样：

```ts
  toggleBtn.addEventListener("click", () => setDrawer(!drawerOpen));
  // Auto-collapse after submit so the terminal returns to full height.
  inputForm.addEventListener("submit", () => { setDrawer(false); });

  renderSpecialKeysBar(toolbar, send);
```

改成：

```ts
  toggleBtn.addEventListener("click", () => setDrawer(!drawerOpen));
  // Auto-collapse after submit so the terminal returns to full height.
  inputForm.addEventListener("submit", () => { setDrawer(false); });

  // Mobile quick-launch: one tap → new session from the kb-cc template.
  // Sits between the input drawer toggle (✎) and the special-keys bar.
  renderQuickLaunchButton({
    parent: toolbar,
    onStarted: (name) => { openSession(name); },
  });

  renderSpecialKeysBar(toolbar, send);
```

- [ ] **Step 3: 跑单测 + build 确保 wiring 无类型错误**

```bash
bun test 2>&1 | tail -5
bun run build:web 2>&1 | tail -5
```

Expected: 单测全过；build 成功无 TS error。

- [ ] **Step 4: Commit**

```bash
git add src/web/mobile/mobile-view.ts
git commit -m "feat(mobile): wire quick-launch button into toolbar"
```

---

### Task 9: 加按钮 CSS

**Files:**
- Modify: `src/web/style.css`

复用 `.mobile-toolbar__toggle` 的尺寸 / 间距方向（同 toolbar 子元素）。视觉权重略低于 `✎`。

- [ ] **Step 1: 在 `src/web/style.css` 找到 `.mobile-toolbar__toggle` 段（grep 定位），在其后追加：**

```css
.mobile-toolbar__quick-launch {
  appearance: none;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.18);
  color: inherit;
  font: inherit;
  font-size: 1.1rem;
  line-height: 1;
  padding: 0.45rem 0.7rem;
  border-radius: 0.4rem;
  cursor: pointer;
  margin-left: 0.4rem;
}

.mobile-toolbar__quick-launch:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.mobile-toolbar__quick-launch:not(:disabled):active {
  background: rgba(255, 255, 255, 0.08);
}
```

注：若文件不存在 `.mobile-toolbar__toggle` 选择器（已合并到别的位置），把以上 CSS 追加到文件末尾即可。

- [ ] **Step 2: 跑 build 确认 CSS 无语法错误**

Run: `bun run build:web 2>&1 | tail -5`

Expected: build 成功。

- [ ] **Step 3: Commit**

```bash
git add src/web/style.css
git commit -m "style(mobile): add quick-launch button styling in toolbar"
```

---

### Task 10: E2E happy-path 测试

**Files:**
- Modify: `tests/e2e/mobile.e2e.ts`

playwright.config.ts 的 mobile project regex 是 `/mobile\.e2e\.ts/`，只匹配这一个文件。直接 append 到该文件。

- [ ] **Step 1: 在 `tests/e2e/mobile.e2e.ts` 的 `test.describe("mobile view", () => {` block 内追加：**

```ts
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
```

- [ ] **Step 2: 跑 mobile e2e**

Run: `bunx playwright test --project=mobile tests/e2e/mobile.e2e.ts 2>&1 | tail -20`

Expected: 之前的 2 个 mobile test + 新加的 1 个 = 3 pass。

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/mobile.e2e.ts
git commit -m "test(e2e): mobile quick-launch button creates kb-cc session and auto-switches"
```

---

### Task 11: 全套回归 + push + 起 PR + 更新 work folder

**Files:**
- 无新建；外部：work folder progress.md

- [ ] **Step 1: 跑全套单测 / lint**

Run: `bun test 2>&1 | tail -10`

Expected: 全部 pass，0 fail，含 lint-no-default-socket。

- [ ] **Step 2: 跑全部 e2e**

Run: `bun run test:e2e 2>&1 | tail -20`

Expected: 全部 pass（mobile 3 + pwa 既有 + desktop 既有；具体取决于 playwright project regex 实际匹配）。

- [ ] **Step 3: 查看 commit history 确认原子化**

Run: `git log --oneline origin/main..HEAD`

Expected: 大致 10-12 个原子化 commit（spec 2 + 实现 ~8 + test ~3）。

- [ ] **Step 4: push 到 origin**

```bash
git push -u origin feat/mobile-quick-launch
```

Expected: 创建远端分支。

- [ ] **Step 5: 起 PR**

```bash
gh pr create \
  --base main \
  --head feat/mobile-quick-launch \
  --title "feat(mobile): quick-launch button for one-tap session start (kb-cc contract)" \
  --body "$(cat <<'EOF'
## Summary
- 移动端 toolbar 加一个 `+` 按钮（介于 ✎ 与 special-keys-bar 之间），点击后通过现有 `POST /templates/:id/run` 通道，用契约 id `kb-cc` 起一个新 tmux session。
- 后端 **0 改动**；前端新增 `src/web/mobile/quick-launch.ts`（pure helper + render fn）。
- 知识库绝对路径与 `cc -f` 命令**不进 repo**——repo 里 `deploy/templates.yaml.example` 加 `kb-cc` 占位 entry（cwd `~`、cmd `sh`），用户拷贝到 `~/.config/tmux-hub/templates.yaml` 时改成自己的路径与命令。

## Design Docs
- Spec: `docs/superpowers/specs/2026-05-23-mobile-quick-launch-design.md`
- Plan: `docs/superpowers/plans/2026-05-23-mobile-quick-launch-plan.md`

## Implementation
- `src/shared/protocol.ts`：导出 `MOBILE_QUICK_LAUNCH_TEMPLATE_ID = "kb-cc"`。
- `src/web/mobile/quick-launch.ts`：
  - `runQuickLaunch(opts)`：pure async helper，按 200 / 404 / 500 / network / malformed 分支调 callback。
  - `renderQuickLaunchButton(opts)`：mount 时 GET `/templates` 缓存 `kb-cc.cwd_choices[0]`；mount 失败 / template 缺失 → 按钮 disabled + title 提示；点击时 POST 走 helper。
- `src/web/mobile/mobile-view.ts`：把按钮挂到 toolbar，`onStarted(name) → openSession(name)`。
- `src/web/style.css`：`.mobile-toolbar__quick-launch` 风格与 `.mobile-toolbar__toggle` 对齐，disabled 态灰显。
- `deploy/templates.yaml.example`：加 `kb-cc` 占位 entry（注释强调拷贝时改 cwd + cmd）。

## Tests
- Unit (Bun): `tests/unit/quick-launch.test.ts` — 5 个 case 覆盖 200 / 404 / 500 / network throw / malformed。
- E2E (Playwright mobile project, iPhone 14): `tests/e2e/mobile.e2e.ts` 追加 1 个 happy-path：点按钮 → tmux \`kb-cc-*\` session 出现 → 移动端 select 切到该 session。

## User Machine Setup
本 PR 不动用户的 \`~/.config/tmux-hub/templates.yaml\`。用户机器配置示例见 spec §10。配好后 \`svc restart tmux-hub\` 即可。

## Rollback
- 单 commit 级：\`git revert <hash>\`。
- 整 PR 级：revert merge commit。
- 服务端无 schema 改动，无数据迁移，回滚零成本。

## Out of Scope (future)
- Schema 加 \`surface: mobile|desktop|all\` 字段隐藏桌面端 (本 PR 让桌面 template-drawer 也展示 kb-cc，已与用户对齐)。
- 桌面 Chrome xterm 底部不可见、CF Access JWT stub 等 Phase-2 backlog。
EOF
)"
```

Expected: PR URL 打印出来。

- [ ] **Step 6: 更新 Zettelkasten work folder progress.md**

切到 Zettelkasten work folder：

```bash
cd "/Users/uther/Library/Mobile Documents/iCloud~md~obsidian/Documents/Zettelkasten/智元工作/工作记录/2026/05/21/web-tui-hub"
```

在 `progress.md` 的 Changelog 顶部追加一行（时间换成实际、PR 编号换成实际）：

```markdown
| 2026-05-23 0X:XX | mobile quick-launch PR | feat/mobile-quick-launch → PR #X 提交；spec/plan/实现/unit/e2e 完整；kb-cc 契约 id；后端 0 改动 |
```

并在 "Current" 段标记本次 session 收尾。

```bash
git add 智元工作/工作记录/2026/05/21/web-tui-hub/progress.md
git commit -m "docs(work): mobile quick-launch PR submitted; record in web-tui-hub progress"
```

注意：Zettelkasten 仓库的 commit / push 走 `/git` skill 的常规流程，与 tmux-hub repo PR 独立。

---

## Self-Review

**Spec coverage check：**

| Spec § | 任务覆盖 |
|--------|---------|
| §3 In scope: 移动端 toolbar 加按钮 | Task 8 |
| §3 In scope: 固定调 `kb-cc` template | Task 1, 4, 7 |
| §3 In scope: 自动切 session | Task 8 onStarted → openSession |
| §3 In scope: templates.yaml.example 加示例 | Task 2 |
| §3 In scope: 友好降级 | Task 7 (mount 时 cwd 拿不到则永久 disabled) + Task 4-6 helper 内 404 toast |
| §3 In scope: Loading 态 disabled | Task 7 |
| §3 In scope: 单测 + e2e | Task 3-6 (unit) + Task 10 (e2e) |
| §4.1 mount-time GET /templates 缓存 cwd | Task 7 |
| §4.2 protocol.ts 常量 | Task 1 |
| §4.3 不动 schema | 全 plan 不改 zod schema |
| §4.4 个人路径不进 repo | Task 2 (example 用 `~` + sh) |
| §5.1 按钮位置 toolbar ✎ 右 | Task 8 (插入位置在 toggleBtn 之后、specialKeysBar 之前) |
| §5.2 disabled / aria-label / title | Task 7 |
| §5.3 交互流程 | Task 4-7 |
| §6 改动清单（8 个文件） | Task 1-2, 4, 7, 8, 9, 3-6 (test), 10 |
| §7.1 helper 单测 | Task 3-6 |
| §7.2 e2e happy-path | Task 10 |
| §8 验收（PR + 测试 + rollback） | Task 11 |

**Placeholder scan：** 无 TBD / TODO / "implement later" / "similar to Task N"。所有 code block 都给了完整可粘贴代码。

**Type consistency：**
- `MOBILE_QUICK_LAUNCH_TEMPLATE_ID` 在 Task 1 定义，Task 4 / 7 引用一致。
- `QuickLaunchFetcher` 类型 = `(input: string, init?: RequestInit) => Promise<Response>`，与 `hubFetch` 签名兼容（Task 7 直接传 `hubFetch` 进 `runQuickLaunch`）。
- `onError` 第一参数枚举 `"not-configured" | "runtime"`，Task 4-6 测试都用这个字面量；Task 7 渲染层 switch 也用。
- `renderQuickLaunchButton` 返回 `HTMLButtonElement`（Task 7），Task 8 调用方不依赖返回值，OK。

**Gap：** 无。所有 spec 要求都有 task 对应。

---

## Execution Choice

Plan 共 11 个 task / ~35 step / ~10-12 个原子 commit。

按 superpowers:writing-plans 末尾约定，请选择执行方式：

1. **Subagent-Driven**（推荐）：dispatch 一个 fresh subagent 每 task，task 间 review，便于隔离。
2. **Inline Execution**：当前 session 顺序跑，用 checkpoint 分段。
