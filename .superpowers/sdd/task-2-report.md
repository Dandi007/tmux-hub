# Task 2 Report

## 做了什么
- 按 brief 在 `/Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status/tests/e2e/mobile.e2e.ts` 新增回归用例 `mobile header after cleanup still supports create and kill`，锁定移动端 header 清理后 `+` 新建会话与 `⏻` 关闭会话主路径仍可用。
- 先执行 red 阶段验证：
  - 按 brief 原命令在 `/Volumes/Data/code/self/tmux-hub` 运行时，得到 `No tests found.`，说明该命令没有命中当前 worktree；这条结果原样记录。
  - 随后在目标 worktree 运行同一 grep 用例，得到真实失败：测试拿到了共享 E2E 环境里已有的旧 `kb-cc-*` session，导致 kill 后断言目标 session 仍存在于列表。
- 检查 `src/web/mobile/mobile-view.ts` 现状，确认：
  - 文件中已经没有 `openVoiceHistory` import/调用；
  - 也没有 `picker.onRename = ...` 接线；
  - 因此 production code 已满足 brief 的“删除历史入口与 rename 接线”要求，本任务无需再改 `mobile-view.ts`。
- 将新增回归测试收紧为“只识别本次点击 `+` 后新创建的 `kb-cc-*` session”，避免被共享 E2E 基线中的历史会话污染。
- 顺手把已有用例 `+ opens template picker; selecting a template starts a session and switches to it` 做了同样的稳定化处理，因为扩大验证时它暴露出同一类假设问题；仍然只改 mobile E2E 路径，没有改 desktop、后端或 voice state machine。

## 改了哪些文件
- 修改：`/Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status/tests/e2e/mobile.e2e.ts`
- 新增：`/Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status/.superpowers/sdd/task-2-report.md`
- 未改但复核过：`/Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status/src/web/mobile/mobile-view.ts`

## 运行了哪些测试及原始结果

### 1) brief 原命令（记录原样）
Command:
```bash
cd /Volumes/Data/code/self/tmux-hub && npx playwright test tests/e2e/mobile.e2e.ts --grep "mobile header after cleanup still supports create and kill"
```
Result:
```text
Exit code 1
Error: No tests found.
Make sure that arguments are regular expressions matching test files.
```

### 2) red：在目标 worktree 跑新增回归用例
Command:
```bash
cd /Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status && npx playwright test tests/e2e/mobile.e2e.ts --grep "mobile header after cleanup still supports create and kill"
```
Result:
```text
Exit code 1
1 failed
[mobile] › tests/e2e/mobile.e2e.ts › mobile view › mobile header after cleanup still supports create and kill
expect(locator('.session-picker__item[data-session="kb-cc-20260624012053"]')).toHaveCount(0)
Expected: 0
Received: 1
```
说明：失败原因不是 header 行为坏掉，而是测试误拿到了共享 E2E 环境中的旧 `kb-cc-*` session。

### 3) green：修正新增回归用例后重跑聚焦用例
Command:
```bash
cd /Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status && npx playwright test tests/e2e/mobile.e2e.ts --grep "mobile header after cleanup still supports create and kill"
```
Result:
```text
1 passed (8.5s)
```

### 4) 扩大验证（第一次）
Command:
```bash
cd /Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status && npx playwright test tests/e2e/mobile.e2e.ts --grep "mobile header shows picker plus create and kill only|mobile header after cleanup still supports create and kill|kill button shows confirm modal — cancel keeps the session alive|kill button confirm destroys the session and switches to the survivor|\+ opens template picker; selecting a template starts a session and switches to it"
```
Result:
```text
Exit code 1
4 passed
1 failed
[mobile] › tests/e2e/mobile.e2e.ts › mobile view › + opens template picker; selecting a template starts a session and switches to it
Expected .session-picker__name to equal the newly created session
Received a different pre-existing/newer kb-cc-* session name
```
说明：现有 `+` 用例有同样的“抓第一个 kb-cc-*”不稳问题。

### 5) 扩大验证（修稳后 fresh run）
Command:
```bash
cd /Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status && npx playwright test tests/e2e/mobile.e2e.ts --grep "mobile header shows picker plus create and kill only|mobile header after cleanup still supports create and kill|kill button shows confirm modal — cancel keeps the session alive|kill button confirm destroys the session and switches to the survivor|\+ opens template picker; selecting a template starts a session and switches to it"
```
Result:
```text
5 passed (22.5s)
```

## self-review
- 对照 brief 复核后，确认本任务的产品目标是“移动端顶部 UI 清理后，`+` / `⏻` 主路径仍然可用”，而不是强制要求一定要有新的 production diff。
- `mobile-view.ts` 已经满足：不再 import/调用 `openVoiceHistory`，也不再设置 `picker.onRename`；因此没有为了“看起来完成任务”而做无意义代码改动。
- 所有改动都限制在 mobile E2E 路径，没有改 desktop、`voice-input.ts` 状态机、`voice-history.ts` 后端/overlay，符合全局约束。
- 新增测试和顺手修稳的旧测试都在验证用户可感知行为，而不是内部实现细节，符合仓库 E2E 契约。

## concerns
- brief 中给出的第 2 步命令使用的是基仓库路径 `/Volumes/Data/code/self/tmux-hub`，在当前实际工作目录 `/Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status` 下会出现 `No tests found.`。本次已记录并改用目标 worktree 路径完成真实 red/green 验证。
- 当前扩展验证日志里仍可见与历史测试会话切换相关的 `viewport pin failed` / `resize-window failed` 警告，但本次 5 个相关 mobile header E2E 全部通过，且这些警告不属于 Task 2 交付范围；未在本任务内扩 scope 处理。

---

## 2026-06-24 reviewer follow-up（Important finding 修复）

### 修了什么
- 修复了 reviewer 指出的唯一阻塞项：`tests/e2e/mobile.e2e.ts` 的 create+kill 回归用例在点击“关闭当前 session”前，只确认了新 session 已出现在 picker 列表中，但没有确认 header 当前激活 session 已真正切换到该新 session。
- 最小化修法是在同一用例里补一条条件等待：`await expect(page.locator(".session-picker__name")).toHaveText(created!, { timeout: 10_000 });`，确保 header active session 已切到本次新建的 session 后，再去点 `关闭当前 session`。
- 这样 kill 目标就和断言目标对齐，消除了“列表已出现但当前 active 仍是旧 session”导致的竞态与潜在 flaky。

### 改了哪些文件
- 修改：`/Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status/tests/e2e/mobile.e2e.ts`
- 追加记录：`/Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status/.superpowers/sdd/task-2-report.md`

### 运行了哪些测试及原始结果

#### 1) create+kill 回归用例
Command:
```bash
cd /Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status && npx playwright test tests/e2e/mobile.e2e.ts --grep "mobile header after cleanup still supports create and kill"
```
Result:
```text
Running 1 test using 1 worker
[mobile] › tests/e2e/mobile.e2e.ts:125:3 › mobile view › mobile header after cleanup still supports create and kill
1 passed (6.3s)
```

#### 2) kill button 覆盖测试
Command:
```bash
cd /Volumes/Data/code/worktrees/tmux-hub/mobile-header-voice-status && npx playwright test tests/e2e/mobile.e2e.ts --grep "kill button"
```
Result:
```text
Running 2 tests using 1 worker
[mobile] › tests/e2e/mobile.e2e.ts:175:3 › mobile view › kill button shows confirm modal — cancel keeps the session alive
[mobile] › tests/e2e/mobile.e2e.ts:192:3 › mobile view › kill button confirm destroys the session and switches to the survivor
2 passed (8.4s)
```

### self-review
- 改动只落在 `tests/e2e/mobile.e2e.ts`，没有改 `voice-input.ts`、`voice-history.ts`、desktop 或其他 production code，符合本轮 fix 的边界要求。
- 修复直接对应 reviewer finding，没有顺手改其它断言或扩展更多测试逻辑。
- 条件等待选的是用户可见状态 `session-picker__name`，比等待内部事件或增加裸超时更贴近真实行为，也更符合 condition-based waiting。

### concerns
- 本次按要求覆盖了 create+kill 回归用例和 `kill button` grep 集；未额外重跑整个 `tests/e2e/mobile.e2e.ts` 文件，因为用户要求是“至少这些都要跑”，且本轮只修这一个阻塞项。
