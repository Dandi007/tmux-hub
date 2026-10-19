# 同名重建的自动重开要有期限（#140）

## 需求
来源：rsi meta Auditor 提交、meta 复核过的 #140。#138 引入的 `reopenName` 只在同名 `session_created` 到达时清除。用户正在看的会话 `x` 被 kill 后，即使用户已经切到了 `y`，之后任何时候同名 `x` 被重新创建（rsi driver 每天 00:00 换会话、STOP 后隔很久再拉起），所有开着的页面都会跳到 `x`，抢走焦点。

## 设计
- 新增 `src/web/reopen-after-remove.ts` 的 `ReopenAfterRemove`，desktop 和 mobile 共用：`removed(name)` 记录名字和时间；`take(name)` 只在名字匹配、且离移除不超过 `REOPEN_WINDOW_MS`（30 秒）时返回 true，并且只返回一次；`cancel()` 用来取消。
- 两个 view 的 `openSession` 增加 `auto` 选项。页面自己发起的打开（移除后按 activity 选的 fallback，以及同名重开）带 `auto: true`；其余调用都视为用户操作（点 tab、快捷键、模板启动、`__tmuxHub.openSession`），会先 `cancel()`。这样可以在一个入口统一处理，不用逐个改调用点。
- 30 秒的依据：registry 每 2 秒 poll 一次，同名重建一般在同一次 poll 里同时产生 removed 和 created；确认移除最多要 3 次 poll（约 6 秒）。driver 的 kill 加 `POST /sessions` 在几秒内完成。

## 验收
- 单测 `tests/unit/reopen-after-remove.test.ts`：窗口内重开一次；超出窗口不重开；cancel 之后不重开。
- E2E（desktop）「a killed session recreated after the user moved on does not steal focus」：打开 a，kill a，等 tab 消失，用户点 b，再把第三个 managed 会话 rename 成 a（确认移除后 a 已不是 managed，rename 是同名回来的方式），1 秒后 b 仍是 active。改动前红，改动后 `--repeat-each=3` 全绿。
- 原有的 happy path（fidelity-suite「a session recreated under the same name keeps streaming to the page」，kill 后立即重建并自动重开）仍是绿的。

## 部署
合入后 deploy-dogfood，核对运行 commit，并在 dogfood 打开页面确认会话列表和切换正常。
