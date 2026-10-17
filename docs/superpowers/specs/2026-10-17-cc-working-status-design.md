# Claude Code 工作中状态改用屏幕 spinner 行判断

- 日期：2026-10-17（RSI 第 8 轮）
- 来源：backlog P1「agent 状态误报」

## 需求

Claude Code 会话在思考、流式输出、执行工具时，hub 应显示「⚡ 工作中」；只有它真正在等用户输入时才显示「💬 等待输入」。

## 根因（实测）

hub 只看 `pane_title`：首字符 `✳` 判为 idle，braille spinner 判为 working（`src/web/shared/cc-status.ts`）。Claude Code 2.1.302 在整个 turn 里都把标题保持为 `✳ <任务名>`。对 dogfood 上正在工作的 rsi-tmux-hub 会话，以 200ms 间隔采样 90 秒，404/404 次都是 `✳`，期间覆盖了思考、流式输出和工具执行。因此 CC 会话永远显示「等待输入」。

可靠的信号在屏幕上：工作时，输入框上方有一行 spinner 状态行，例如 `✽ Swooping… (2m 43s · ↓ 2.7k tokens)`、`· Swooping… (running PostToolUse hooks… 1/2)`；结束后变为 `✻ Baked for 48s · done 9:36 PM`（没有省略号和括号）。

## 设计

- `src/server/session-registry.ts` 的 `listSessions` 新增 `enrichClaudeTitle`，沿用已有的 `enrichCodexTitle` 模式：
  - 只处理标题以 `✳` 开头的会话，对其 capture 可见屏（不带 `-S`）；
  - `isClaudeWorkingScreen`：在最后 25 个非空行内匹配 `^[·✢✳✶✻✽*] \S.*…\s+\((\d+[smh]|running|esc to interrupt)`；
  - 匹配到时，把标题首字符 `✳` 换成 braille 帧 `⠋`。客户端已有逻辑会判为 working，标题文字不变（marker 会被剥掉）。
- 协议和客户端都不改，已经打开的旧页面也会立即显示正确状态。
- 开销：每 2 秒的 registry 轮询中，每个 `✳` 会话多一次 capture-pane（只取可见屏）。CC 会话一般只有几个。

未采用的方案：
- 新增显式的 `agent_status` 字段：协议和客户端都要改，旧页面不生效；而用 marker 置换，现有的判断链路可以直接复用。
- 用服务端 emulator 的屏幕：只有已 attach 的会话才有 emulator，会话列表里未打开的会话就判断不了。

## 验收

- 单测 `tests/unit/cc-working-status.test.ts`：5 种工作中 spinner 行判为 working；完成态、普通文本判为 idle；滚出底部窗口的旧 spinner 行不算；`listSessions` 只对 `✳` 会话做 capture，工作中的会话标题首字符变为 braille，标题文字不变。修复前 fail。
- dogfood 真实屏幕：工作中的 rsi-tmux-hub 判为 true，空闲的 vault-cc 判为 false。
- 全量 unit/integration 与 E2E 全绿。

## 部署与发布

只改服务端。合入后 `deploy-dogfood`，在 dogfood UI 上确认 rsi-tmux-hub 在本 loop 工作时显示 ⚡，vault-cc 显示 💬。prod 由人前移 `accepted` 后生效。
