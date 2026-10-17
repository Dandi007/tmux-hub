# desktop pool：隐藏 tab 不再 pin pane，激活时补发

## 需求（RSI loop 自定，backlog P1「desktop pool 每个 tab 都会 resync」）

desktop 视图的 terminal pool 为每个会话常驻一个 slot，非激活 slot 用 `visibility:hidden` 隐藏，但布局尺寸仍在。于是窗口 resize、`focus`、`visibilitychange`（reassert 逻辑）、重连都会让**每个** slot fit 并发送 `resize`：

1. 服务端对每个会话 `resize-window`，再各做一次对齐 capture 加 resync（第 5 轮引入），N 个 tab 就产生 N 份 snapshot 流量和重绘。
2. 更实际的问题：「latest active client wins」本意是让用户正在看的那个会话回到本客户端的尺寸，但隐藏 tab 也会 reassert。用户在手机上看会话 X 时，桌面浏览器只要获得一次焦点，就会把 X 的尺寸抢回桌面尺寸，即使桌面上 X 只是个隐藏 tab。

E2E 复现：两个 tab，a 激活、b 隐藏，窗口缩小后 b 的 tmux window 也从 197x47 变成 140x33。

## 设计（`src/web/terminal.ts`）

- 新增 `sendResizeIfVisible()`：仅当 `isTermVisible()`（INV-5/6 共用的可见性判定）且 `shouldSendResize`（web 拥有 viewport）时才发 resize。窗口 resize 的 debounce、重连 onopen、首次 ws open 的 100ms 补发、native 释放后 web reclaim 都改为走它。
- `handle.fit()`（pool activate 时调用）在 fit 后 `publishResize()`：补上隐藏期间延后的尺寸，tab 切换也满足「latest active client wins」。尺寸没变时服务端 `ResyncScheduler` 不会标 dirty，不会产生 resync。
- mobile 视图只有一个可见 terminal，行为不变；页面整体隐藏（visibilityState hidden）时同样不发，回到前台由已有的 visibilitychange reassert 补发。

不在本次范围：服务端在 ws open 时按 URL 里的 cols/rows 给 pane pin 尺寸（隐藏 slot 首次连接或重连时仍会 pin 一次）。它发生在连接建立时而不是焦点或 resize 时，影响较小，记入 backlog。

## 验收

- 新 E2E「window resize only resizes the visible tab; hidden tab catches up on activation」改前红（b 被改成 140x33），改后 `--repeat-each=5` 5/5。
- 全量 unit/integration 与 E2E 不回归（含 fidelity oracle 的 resize 用例）。
- dogfood：两个 tab，缩小窗口后隐藏 tab 的 tmux 尺寸不变；切过去后对齐；oracle diffRows=0。

## 部署

合入后 `deploy-dogfood`；不涉及 prod。
