# Mobile Header Voice Status Relayout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收敛移动端顶部控件，移除语音历史与重命名入口，并把现有语音运行态提示迁到 `+` 按钮下方的 header 次行而不改变状态机逻辑。

**Architecture:** 继续由 `mobile-view.ts` 编排移动端页面结构；`session-picker.ts` 只负责 session 选择和 kill 控制，不再承载 rename。语音状态仍由 `renderVoiceButton()` 触发，但展示从全局 sticky toast 改为 header 内页面状态条，显示文案与时序保持现状。

**Tech Stack:** Bun, TypeScript, Vite, Playwright, xterm.js

## Global Constraints

- 只改移动端路径：`src/web/mobile/*`、`src/web/style.css`、`tests/e2e/mobile.e2e.ts`。
- 不改 `src/web/mobile/voice-input.ts` 的录音、上传、SSE、状态机逻辑。
- 不改 `src/web/mobile/voice-history.ts` 的 overlay 实现与后端接口。
- 不在本次改动中为语音历史寻找新的入口位置。
- 不改 desktop header / session list 行为。
- 语音状态文案与时序保持现状：`recording / transcribing / cleaning / idle / error` 的语义不变。
- 顶部最终只保留 session picker、`+` 新建会话、`⏻` 关闭当前 session。

---

## File Map

- `src/web/mobile/session-picker.ts`
  - 当前负责：session picker 主体、rename 按钮、kill 按钮、action row 导出。
  - 本次改为：session picker 主体、kill 按钮、action row 导出；删除 rename 按钮与 `onRename` 接口。
- `src/web/mobile/mobile-view.ts`
  - 当前负责：移动端 header、terminal、input bar、语音按钮、语音状态 toast、rename / kill 接线。
  - 本次改为：删除 header 的语音历史按钮与 rename 接线；新增 header 次行语音状态条；保持 kill / quick-launch / voice input 主链路。
- `src/web/style.css`
  - 当前负责：移动端 header 单行布局、`mobile-history-btn`、session picker 样式、header action 样式。
  - 本次改为：header 两层布局；新增语音状态条样式；移除顶部历史按钮样式的实际使用依赖。
- `tests/e2e/mobile.e2e.ts`
  - 当前覆盖：移动端 `+`、rename、kill、picker、input bar 等行为。
  - 本次改为：删除 rename 用例；新增顶部按钮组合与 header 状态条行为断言。

---

### Task 1: 收敛 session picker 接口并移除 rename 按钮

**Files:**
- Modify: `src/web/mobile/session-picker.ts`
- Test: `tests/e2e/mobile.e2e.ts`

**Interfaces:**
- Consumes:
  - `type SessionInfo` from `@shared/protocol`
  - `getClaudeCodeStatus(paneTitle: string): CCStatus`
  - `getCCStatusIcon(status: CCStatus): string`
- Produces:
  - `type SessionPickerHandle = { root: HTMLElement; actionRow: HTMLElement; refresh(...): void; setActive(name: string): void; getValue(): string | null; focus(): void; onKill: ((current: string) => void) | null }`
  - `renderSessionPicker(parent: HTMLElement, onSelect: (name: string) => void): SessionPickerHandle`

- [ ] **Step 1: 写一个失败的 E2E，用按钮可见性约束顶部控件组合**

```ts
test("mobile header shows picker plus create and kill only", async ({ page, ctx }) => {
  const name = await ctx.createSession();

  await openApp(page);
  await selectSession(page, name);

  await expect(page.getByRole("button", { name: "新建会话" })).toBeVisible();
  await expect(page.getByRole("button", { name: "关闭当前 session" })).toBeVisible();
  await expect(page.getByRole("button", { name: "重命名当前 session" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "我的语音历史" })).toHaveCount(0);

  ctx.tmuxE2E(["kill-session", "-t", name]);
});
```

- [ ] **Step 2: 运行测试，确认它因旧按钮仍存在而失败**

Run: `cd /Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status && npx playwright test tests/e2e/mobile.e2e.ts --grep "mobile header shows picker plus create and kill only"`

Expected: FAIL，能看到 `重命名当前 session` 或 `我的语音历史` 仍然存在。

- [ ] **Step 3: 最小化修改 `session-picker.ts`，删除 rename 按钮与接口**

```ts
export type SessionPickerHandle = {
  root: HTMLElement;
  actionRow: HTMLElement;
  refresh: (sessions: SessionInfo[], activeName: string | null) => void;
  setActive: (name: string) => void;
  getValue: () => string | null;
  focus: () => void;
  onKill: ((current: string) => void) | null;
};

const killBtn = document.createElement("button");
killBtn.type = "button";
killBtn.className = "header-action is-danger";
killBtn.setAttribute("aria-label", "关闭当前 session");
killBtn.textContent = "⏻";

const triggerRow = document.createElement("div");
triggerRow.className = "session-picker__trigger-row";
trigger.append(nameSpan, chevron);
triggerRow.append(trigger, killBtn);
root.appendChild(triggerRow);

let onKillCb: ((current: string) => void) | null = null;

killBtn.addEventListener("click", () => {
  if (activeName && onKillCb) onKillCb(activeName);
});

return {
  root,
  actionRow: triggerRow,
  refresh,
  setActive,
  getValue: () => activeName,
  focus: () => trigger.focus(),
  get onKill() { return onKillCb; },
  set onKill(fn: ((current: string) => void) | null) { onKillCb = fn; },
};
```

- [ ] **Step 4: 运行同一条测试，确认按钮组合现在通过**

Run: `cd /Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status && npx playwright test tests/e2e/mobile.e2e.ts --grep "mobile header shows picker plus create and kill only"`

Expected: PASS

- [ ] **Step 5: 提交这一小步**

```bash
cd /Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status
git add src/web/mobile/session-picker.ts tests/e2e/mobile.e2e.ts
git commit -m "refactor(mobile): remove rename button from session picker"
```

---

### Task 2: 在 mobile view 中移除语音历史入口与 rename 接线

**Files:**
- Modify: `src/web/mobile/mobile-view.ts`
- Test: `tests/e2e/mobile.e2e.ts`

**Interfaces:**
- Consumes:
  - `renderSessionPicker(header: HTMLElement, onSelect: (name: string) => void): SessionPickerHandle`
  - `killSession(current: string): Promise<void>`
  - `confirmModal(opts): Promise<boolean>`
- Produces:
  - `renderMobile(root: HTMLElement): void` 不再 import 或调用 `openVoiceHistory`
  - `renderMobile(root: HTMLElement): void` 不再调用 `picker.onRename = ...`

- [ ] **Step 1: 写一个失败的 E2E，用回归用例锁住 `+` 与 `⏻` 仍可工作**

```ts
test("mobile header after cleanup still supports create and kill", async ({ page, ctx }) => {
  await openApp(page);

  const createBtn = page.getByRole("button", { name: "新建会话" });
  await expect(createBtn).toBeVisible({ timeout: 10_000 });
  await createBtn.click();
  await expect(page.locator(".template-picker")).toBeVisible();
  await page.locator(".template-picker").getByRole("button", { name: "知识库 cc" }).click();

  let created: string | undefined;
  for (let i = 0; i < 40; i++) {
    const names = ctx.tmuxE2E(["list-sessions", "-F", "#{session_name}"]).split("\n").filter(Boolean);
    created = names.find((n) => n.startsWith("kb-cc-"));
    if (created) break;
    await page.waitForTimeout(200);
  }
  expect(created).toBeTruthy();

  await page.getByRole("button", { name: "关闭当前 session" }).click();
  await expect(page.locator(".modal-dialog")).toBeVisible();
  await page.locator(".modal-dialog__actions button.is-danger").click();
  await expect(page.locator(`.session-picker__item[data-session="${created!}"]`)).toHaveCount(0, { timeout: 10_000 });
});
```

- [ ] **Step 2: 运行测试，确认当前实现下它先失败或依赖旧 header 结构**

Run: `cd /Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status && npx playwright test tests/e2e/mobile.e2e.ts --grep "mobile header after cleanup still supports create and kill"`

Expected: 在开始改 `mobile-view.ts` 前失败，或需要旧按钮结构才能通过。

- [ ] **Step 3: 最小化修改 `mobile-view.ts`，删除历史入口与 rename 接线**

```ts
import { showToast } from "../ui/toast";
import { renderVoiceButton, type VoiceStatus } from "./voice-input";

export function renderMobile(root: HTMLElement): void {
  root.replaceChildren();
  root.className = "mobile-shell";

  enableWakeLock();

  const header = document.createElement("header");
  header.className = "mobile-shell__header";
  root.appendChild(header);

  // 其余结构保持原样
  const picker = renderSessionPicker(header, (name) => {
    void openSession(name);
  });

  picker.onKill = (current: string) => {
    void confirmModal({
      title: "关闭会话",
      body: `确定要关闭会话「${current}」吗？该会话中的所有进程将被终止。`,
      confirmLabel: "关闭",
      danger: true,
    }).then(async (confirmed) => {
      if (!confirmed) return;
      try {
        await killSession(current);
        showToast(`会话「${current}」已关闭`, "info");
      } catch (e) {
        showToast(`关闭失败：${(e as Error).message}`, "error");
      }
    });
  };
}
```

- [ ] **Step 4: 运行回归测试，确认 `+` 与 `⏻` 主路径仍通过**

Run: `cd /Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status && npx playwright test tests/e2e/mobile.e2e.ts --grep "mobile header after cleanup still supports create and kill"`

Expected: PASS

- [ ] **Step 5: 提交这一小步**

```bash
cd /Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status
git add src/web/mobile/mobile-view.ts tests/e2e/mobile.e2e.ts
git commit -m "refactor(mobile): drop history and rename header actions"
```

---

### Task 3: 把语音状态从 sticky toast 迁到 header 次行

**Files:**
- Modify: `src/web/mobile/mobile-view.ts`
- Modify: `src/web/style.css`
- Test: `tests/e2e/mobile.e2e.ts`

**Interfaces:**
- Consumes:
  - `renderVoiceButton({ parent, onText, onStatus }): void`
  - `type VoiceStatus = "idle" | "recording" | "transcribing" | "cleaning" | "error"`
- Produces:
  - `voiceStatusRow: HTMLDivElement` 挂在 `header` 内、位于 `picker.root` 之后
  - `setVoiceStatus(s: VoiceStatus, detail?: string): void` 维护 header 次行文本、状态 class 与自动隐藏 timer

- [ ] **Step 1: 写一个失败的 E2E，直接验证 header 次行状态条的文案与可见性**

```ts
test("voice runtime status is rendered in header secondary row", async ({ page }) => {
  await openApp(page);

  await page.evaluate(() => {
    const hub = window.__tmuxHub as typeof window.__tmuxHub & {
      __setVoiceHeaderStatus?: (status: "recording" | "transcribing" | "cleaning" | "idle" | "error", detail?: string) => void;
    };
    hub.__setVoiceHeaderStatus?.("recording");
  });

  const row = page.locator(".mobile-shell__voice-status");
  await expect(row).toBeVisible();
  await expect(row).toHaveText(/录音中/);

  await page.evaluate(() => {
    const hub = window.__tmuxHub as typeof window.__tmuxHub & {
      __setVoiceHeaderStatus?: (status: "recording" | "transcribing" | "cleaning" | "idle" | "error", detail?: string) => void;
    };
    hub.__setVoiceHeaderStatus?.("cleaning");
  });
  await expect(row).toHaveText(/整理中/);
});
```

- [ ] **Step 2: 运行测试，确认在实现 header 状态条前失败**

Run: `cd /Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status && npx playwright test tests/e2e/mobile.e2e.ts --grep "voice runtime status is rendered in header secondary row"`

Expected: FAIL，`.mobile-shell__voice-status` 不存在，或调试 hook 尚未导出。

- [ ] **Step 3: 在 `mobile-view.ts` 新增页面内状态条与更新函数，替换旧 toast 状态驱动**

```ts
const voiceStatusRow = document.createElement("div");
voiceStatusRow.className = "mobile-shell__voice-status";
voiceStatusRow.hidden = true;
header.appendChild(voiceStatusRow);

let voiceStatusTimer: number | null = null;

const clearVoiceStatusTimer = (): void => {
  if (voiceStatusTimer !== null) {
    window.clearTimeout(voiceStatusTimer);
    voiceStatusTimer = null;
  }
};

const setVoiceStatus = (s: VoiceStatus, detail = ""): void => {
  clearVoiceStatusTimer();
  voiceStatusRow.classList.remove("is-error", "is-live");

  if (s === "recording") {
    voiceStatusRow.hidden = false;
    voiceStatusRow.classList.add("is-live");
    voiceStatusRow.textContent = detail ? `🎤 ${detail}` : "🎤 录音中";
    return;
  }
  if (s === "transcribing") {
    voiceStatusRow.hidden = false;
    voiceStatusRow.classList.add("is-live");
    voiceStatusRow.textContent = "📝 转写中…";
    return;
  }
  if (s === "cleaning") {
    voiceStatusRow.hidden = false;
    voiceStatusRow.classList.add("is-live");
    voiceStatusRow.textContent = "✨ 整理中…";
    return;
  }
  if (s === "idle") {
    if (!detail) {
      voiceStatusRow.hidden = true;
      voiceStatusRow.textContent = "";
      return;
    }
    voiceStatusRow.hidden = false;
    voiceStatusRow.textContent = detail;
    voiceStatusTimer = window.setTimeout(() => {
      voiceStatusRow.hidden = true;
      voiceStatusRow.textContent = "";
      voiceStatusTimer = null;
    }, 2600);
    return;
  }
  voiceStatusRow.hidden = false;
  voiceStatusRow.classList.add("is-error");
  voiceStatusRow.textContent = detail || "⚠️ 出错了";
  voiceStatusTimer = window.setTimeout(() => {
    voiceStatusRow.hidden = true;
    voiceStatusRow.textContent = "";
    voiceStatusTimer = null;
  }, 3200);
};

renderVoiceButton({
  parent: pill,
  onText: (text) => {
    // 现有插入逻辑保持不变
  },
  onStatus: setVoiceStatus,
});

window.__tmuxHub = {
  ...(window.__tmuxHub ?? {}),
  focusSessionList: () => {
    picker.focus();
  },
  openSession: (name: string) => { void openSession(name); },
  __setVoiceHeaderStatus: setVoiceStatus,
};
```

- [ ] **Step 4: 在 `style.css` 把 header 调整成两层布局并增加状态条样式**

```css
.mobile-shell__header {
  padding: calc(var(--space-2) + var(--safe-top)) 0 0;
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-surface-hi);
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0;
}

.session-picker__trigger-row {
  display: flex;
  align-items: center;
}

.mobile-shell__voice-status {
  min-height: 28px;
  padding: 0 var(--space-3) var(--space-2);
  font-size: 12px;
  color: var(--color-text-mute);
  display: flex;
  align-items: center;
}

.mobile-shell__voice-status[hidden] {
  display: none;
}

.mobile-shell__voice-status.is-live {
  color: var(--color-text);
}

.mobile-shell__voice-status.is-error {
  color: var(--color-danger);
}
```

- [ ] **Step 5: 运行状态条测试，确认显示位置与文案正确**

Run: `cd /Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status && npx playwright test tests/e2e/mobile.e2e.ts --grep "voice runtime status is rendered in header secondary row"`

Expected: PASS

- [ ] **Step 6: 提交这一小步**

```bash
cd /Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status
git add src/web/mobile/mobile-view.ts src/web/style.css tests/e2e/mobile.e2e.ts
git commit -m "feat(mobile): move voice status into header secondary row"
```

---

### Task 4: 清理与补全移动端 E2E 覆盖

**Files:**
- Modify: `tests/e2e/mobile.e2e.ts`

**Interfaces:**
- Consumes:
  - `openApp(page: Page): Promise<void>`
  - `selectSession(page: Page, name: string): Promise<void>`
  - `ctx.createSession(templateId?: string): Promise<string>`
- Produces:
  - 删除旧 rename 用例
  - 保留 `+` / kill / picker 行为回归
  - 新增 voice header row 的 idle/error 终态隐藏断言

- [ ] **Step 1: 写一个失败的 E2E，锁住终态短暂显示后隐藏的行为**

```ts
test("voice header status settles then hides on idle and error", async ({ page }) => {
  await openApp(page);

  const row = page.locator(".mobile-shell__voice-status");

  await page.evaluate(() => {
    const hub = window.__tmuxHub as typeof window.__tmuxHub & {
      __setVoiceHeaderStatus?: (status: "recording" | "transcribing" | "cleaning" | "idle" | "error", detail?: string) => void;
    };
    hub.__setVoiceHeaderStatus?.("idle", "⏱ 松手后0.4s · 网络0.1 转写0.1 整理0.2");
  });
  await expect(row).toBeVisible();
  await expect(row).toHaveText(/松手后/);
  await expect(row).toBeHidden({ timeout: 4000 });

  await page.evaluate(() => {
    const hub = window.__tmuxHub as typeof window.__tmuxHub & {
      __setVoiceHeaderStatus?: (status: "recording" | "transcribing" | "cleaning" | "idle" | "error", detail?: string) => void;
    };
    hub.__setVoiceHeaderStatus?.("error", "⚠️ 出错了");
  });
  await expect(row).toBeVisible();
  await expect(row).toHaveText(/出错了/);
  await expect(row).toBeHidden({ timeout: 4000 });
});
```

- [ ] **Step 2: 运行测试，确认在补齐自动隐藏实现前失败（若 Task 3 已完成，则应直接通过）**

Run: `cd /Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status && npx playwright test tests/e2e/mobile.e2e.ts --grep "voice header status settles then hides on idle and error"`

Expected: 若 Task 3 已完整实现则 PASS；否则 FAIL 并指出终态未隐藏。

- [ ] **Step 3: 清理旧 rename 用例，保留并重排移动端核心回归集**

```ts
// 删除以下两条旧测试：
// - "rename button switches header to edit-mode and renames the session"
// - "rename cancel restores the picker without firing a request"

// 保留并确认这些仍在：
// - "+ opens template picker; selecting a template starts a session and switches to it"
// - "kill button shows confirm modal — cancel keeps the session alive"
// - "kill button confirm destroys the session and switches to the survivor"
// - "session picker opens and closes on trigger click"
```

- [ ] **Step 4: 运行完整 mobile E2E，确认回归集通过**

Run: `cd /Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status && npx playwright test tests/e2e/mobile.e2e.ts`

Expected: PASS，rename 相关用例已移除，新增 header 状态条用例通过。

- [ ] **Step 5: 提交测试清理与补全**

```bash
cd /Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status
git add tests/e2e/mobile.e2e.ts
git commit -m "test(mobile): update header and voice status coverage"
```

---

### Task 5: 最终验证与文档同步

**Files:**
- Modify: `docs/superpowers/specs/2026-06-24-mobile-header-voice-status-design.md`（仅当实现偏差需要回写）

**Interfaces:**
- Consumes:
  - `bun run build`
  - `npx playwright test tests/e2e/mobile.e2e.ts`
- Produces:
  - 已验证的实现分支，可用于 PR

- [ ] **Step 1: 运行构建，确认前端编译无误**

Run: `cd /Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status && bun run build`

Expected: `vite build` 成功完成，无 TypeScript 或 bundling 错误。

- [ ] **Step 2: 运行完整移动端 E2E 套件**

Run: `cd /Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status && npx playwright test tests/e2e/mobile.e2e.ts`

Expected: PASS

- [ ] **Step 3: 若实现与 spec 有命名或边界偏差，回写 spec；否则不改文档**

```md
如果最终类名不是 `.mobile-shell__voice-status`，或语音历史入口处理方式与 spec 不完全一致，
就在 `docs/superpowers/specs/2026-06-24-mobile-header-voice-status-design.md` 中同步实际落地做法。
```

- [ ] **Step 4: 查看工作区，确认只包含预期改动**

Run: `cd /Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status && git status --short`

Expected: 只看到 `src/web/mobile/mobile-view.ts`、`src/web/mobile/session-picker.ts`、`src/web/style.css`、`tests/e2e/mobile.e2e.ts`、以及必要时的 spec 文档。

- [ ] **Step 5: 提交最终整理**

```bash
cd /Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status
git add src/web/mobile/mobile-view.ts src/web/mobile/session-picker.ts src/web/style.css tests/e2e/mobile.e2e.ts docs/superpowers/specs/2026-06-24-mobile-header-voice-status-design.md
git commit -m "feat(mobile): simplify header and relocate voice status"
```

## Self-Review

- **Spec coverage:**
  - 去掉 `🎙` 语音历史入口 → Task 2
  - 去掉 `✎` 重命名入口 → Task 1 / Task 2
  - 顶部只保留 picker / `+` / `⏻` → Task 1 / Task 2
  - 语音状态迁到 `+` 下方 header 次行 → Task 3
  - 状态机与文案时序不变 → Task 3 / Task 4
  - mobile 回归测试通过 → Task 4 / Task 5
- **Placeholder scan:** 未使用 TBD/TODO/“自行处理”类占位；每个任务都给出了明确命令和代码骨架。
- **Type consistency:** 计划中只保留 `onKill` 作为 `SessionPickerHandle` 的可变回调；语音状态调试接口统一命名为 `__setVoiceHeaderStatus(status, detail?)`。
