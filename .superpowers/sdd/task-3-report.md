# Task 3 Report

## 做了什么
- 按 brief 先在 `/Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status/tests/e2e/mobile.e2e.ts` 新增失败用例 `voice runtime status is rendered in header secondary row`，直接验证移动端 header 次行状态条的可见性与文案。
- 在 `/Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status/src/web/mobile/mobile-view.ts` 新增 `voiceStatusRow` 和 `setVoiceStatus(s, detail?)`，把语音运行态从原先 sticky toast 驱动改为 header 次行文案驱动。
- 保持语音状态机仍由 `renderVoiceButton({ onStatus })` 驱动，没有修改 `voice-input.ts` 内部状态机。
- 在 `/Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status/src/web/style.css` 把移动端 header 调整为两层布局，并新增 `.mobile-shell__voice-status`、`.is-live`、`.is-error` 样式。
- 在 `/Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status/src/web/pwa/shortcuts.ts` 扩展 `window.__tmuxHub` 类型，加入 `__setVoiceHeaderStatus` 供 E2E 调试 hook 使用。
- 只改了 mobile 路径及其测试/类型声明，没有改 desktop、`voice-input.ts` 状态机、`voice-history.ts` 后端/overlay。

## 改了哪些文件
- `/Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status/tests/e2e/mobile.e2e.ts`
- `/Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status/src/web/mobile/mobile-view.ts`
- `/Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status/src/web/style.css`
- `/Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status/src/web/pwa/shortcuts.ts`

## 运行了哪些测试及原始结果
1. 失败验证（RED）
   - 命令：`cd /Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status && npx playwright test tests/e2e/mobile.e2e.ts --grep "voice runtime status is rendered in header secondary row"`
   - 原始结果：`FAIL`，报错为 `locator('.mobile-shell__voice-status')` 不存在，符合 brief 对 RED 阶段的预期。

2. 前端构建
   - 命令：`cd /Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status && bun run build`
   - 原始结果：`PASS`
   - 关键输出：
     - `vite v8.0.14 building client environment for production...`
     - `dist/web/assets/mobile-view-C7yZXp5N.js 15.00 kB`
     - `✓ built in 163ms`
     - `PWA v1.3.0`

3. 目标用例复跑（GREEN）
   - 命令：`cd /Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status && npx playwright test tests/e2e/mobile.e2e.ts --grep "voice runtime status is rendered in header secondary row"`
   - 原始结果：`PASS`
   - 关键输出：`1 passed (2.3s)`

4. 移动端全量 E2E 回归
   - 命令：`cd /Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status && npx playwright test tests/e2e/mobile.e2e.ts`
   - 原始结果：`PASS`
   - 关键输出：`18 passed (1.0m)`

5. 额外代码审阅
   - 由 TypeScript reviewer 子 agent 对 diff 做只读 review。
   - 原始结果：未在本次 diff 上发现明确阻塞 bug，但指出仓库现有 `tsc` baseline 非绿，涉及其它 unit test mock 与空值类型问题，不是本任务改动直接引入。

## self-review
- 改动严格围绕 brief：状态展示位置从 sticky toast 迁到 header 次行，保留原有状态语义与时序（recording/transcribing/cleaning 常显，idle/error 自动隐藏）。
- E2E 通过调试 hook 直接驱动 `setVoiceStatus`，验证的是用户可见行为，不依赖内部 toast 实现。
- 没有顺手修 mobile 其它健壮性问题，也没有触碰 desktop 或 voice 状态机内部。
- 之所以在第一次实现后先执行 `bun run build` 再复跑 E2E，是因为测试服务端静态资源直接读 `dist/web`，若不重建会读取旧 bundle，无法验证最新前端代码。

## concerns
- 仓库当前存在与本任务无直接关系的 TypeScript baseline 红灯；review 子 agent 复现到的报错位于未修改的 unit test 文件，未阻塞本任务的 mobile E2E 与构建通过，但后续若要把 `tsc --noEmit` 纳入 gate，需要先 separately 清理这些历史问题。

---

## 2026-06-24 review fix（Important findings 修复）

### 修了什么
- 修复了 `/Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status/src/web/mobile/mobile-view.ts` 中 `setVoiceStatus()` 只更新 header 次行、不触发终端重算的问题。现在统一通过 `applyVoiceStatusRow()` / `hideVoiceStatusRow()` 收口状态条显隐，并在每次高度变化后调度 `term.fit()`，覆盖 `recording`、`transcribing`、`cleaning`、`idle(detail)`、`idle(hidden)`、`error(hidden)` 全部路径。
- 撤回了越界的 `/Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status/src/web/pwa/shortcuts.ts` 语音调试 hook 类型扩展，把调试所需的类型与 helper 局部收口回 `/Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status/src/web/mobile/mobile-view.ts` 与 `/Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status/tests/e2e/mobile.e2e.ts`，避免继续修改非允许路径的行为实现。
- 在 `/Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status/tests/e2e/mobile.e2e.ts` 新增回归用例 `voice header status settles then hides on idle and error`，直接验证 idle/error 自动隐藏，并通过页面内 debug state 断言状态条变化时确实触发了 terminal refit。

### 改了哪些文件
- `/Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status/src/web/mobile/mobile-view.ts`
- `/Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status/tests/e2e/mobile.e2e.ts`
- `/Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status/src/web/pwa/shortcuts.ts`（仅撤回本任务先前越界改动）

### 运行了哪些测试及原始结果
1. 新增失败验证（RED）
   - 命令：`cd /Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status && npx playwright test tests/e2e/mobile.e2e.ts --grep "voice runtime status is rendered in header secondary row|voice header status settles then hides on idle and error"`
   - 原始结果：`FAIL`
   - 关键输出：
     - `1 passed`
     - `1 failed`
     - `Expected: >= 0`
     - `Received: -1`
   - 结论：证明现状下缺少 fit 调试态/可验证 refit 路径，符合 reviewer 指出的阻塞项。

2. 修复中间构建验证
   - 命令：`cd /Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status && bun run build`
   - 原始结果：`PASS`
   - 关键输出：
     - `dist/web/assets/mobile-view-C2iMy8Yg.js 14.99 kB`
     - `✓ built in 160ms`

3. 定向回归验证（GREEN）
   - 命令：`cd /Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status && npx playwright test tests/e2e/mobile.e2e.ts --grep "voice runtime status is rendered in header secondary row|voice header status settles then hides on idle and error"`
   - 原始结果：`PASS`
   - 关键输出：`2 passed (12.3s)`

4. 最终 fresh verification：构建 + 定向 E2E + 全量 mobile E2E
   - 命令：`cd /Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status && bun run build && npx playwright test tests/e2e/mobile.e2e.ts --grep "voice runtime status is rendered in header secondary row|voice header status settles then hides on idle and error" && npx playwright test tests/e2e/mobile.e2e.ts`
   - 原始结果：`PASS`
   - 关键输出：
     - `dist/web/assets/mobile-view-YQKjbbi-.js 15.00 kB`
     - `✓ built in 176ms`
     - `2 passed`
     - `19 passed (1.1m)`

### self-review
- 本轮只处理了 reviewer 指出的两个阻塞项，没有扩 scope 到其它 mobile UI 或 terminal 行为。
- `term.fit()` 触发点被放在状态条所有显隐路径的统一 helper 中，避免只修 `recording` 或只修自动隐藏分支而漏掉其它高度变化场景。
- 调试 hook 没有再放回 `src/web/pwa/shortcuts.ts`，而是局部收口到 mobile view 自己的类型别名，满足“在允许范围内完成测试/类型最小调整”的要求。
- 全量 mobile E2E 通过，说明新增 refit 与调试 hook 没有打坏现有 session picker、输入条、特殊键、图片上传和 SSE 行为。

### concerns
- 全量 mobile E2E 过程中仍能看到仓库既有的 `viewport pin failed` / `resize-window failed` 日志，但测试最终 `19 passed`，且这些日志在本轮修复前也存在；本次未扩 scope 处理该独立问题。
