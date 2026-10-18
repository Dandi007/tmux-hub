# 多设备同看一个会话：被挤占的页面保持与 tmux 一致

## 需求
人审查 backlog P2「resync 只覆盖本页面触发的 resize」。dogfood 实测（临时会话 + 桌面 1400x900 页面 A + 手机 412x800 页面 B）：
- B 打开后把 pane 钉成 56x40，A 的 xterm 仍是 197x47，tmux 按 56 列画的字节落在 197 列网格上，diffRows=30–40；
- B 关掉以后 pane 仍停在 56x40，A **一直错乱**，直到用户点击或聚焦 A（已有的「latest active client wins」重新钉回）。

手机 + 电脑同时开同一个会话是主要使用场景，这属于回传保真问题。

## 设计
tmux 每个 window 只有一个尺寸，所以只能有一个页面拿到自己的尺寸。目标是：其他页面**正确显示** tmux 当前的样子，钉住尺寸的页面离开后自动收回。
- 服务端 `SessionPeers`（`src/server/session-peers.ts`）记录每个会话的 ws，以及最后一个钉住尺寸的 ws。
- 某个 ws 钉住尺寸时（open 时 pin，或 resize 消息生效），给同会话的其他 ws 发 `{kind:"viewport", owner:"web", peer:true, cols, rows}`，并触发它们各自的 `ResyncScheduler.resized`（新尺寸的对齐 snapshot，只发给 `resync=1` 的客户端）。
- 最后钉住尺寸的 ws 关闭时，给其余 ws 发 `{kind:"viewport", owner:"web", released:true}`。
- 客户端（`handleViewportMessage`）：`peer` 时 `term.resize` 采用新尺寸，**不回发 resize**（否则两端互抢）；ownership 仍是 web，之后的 fit / focus / 点击照常重新钉回自己的尺寸。`released` 时执行已有的 `reassertViewport`（文档可见时 fit 并发 resize；隐藏的 pool slot 不发，激活时再钉）。
- 旧客户端：对 owner=web 的 viewport 消息本来就不做任何事，多出来的字段会被忽略，兼容。
- `/metrics` 增加 `tmux_hub_ws_peers`，用来发现 peer 表泄漏（应与 ws_connections 一致）。

## 验收
- E2E（fidelity suite，emulator + emulator-mobile）新用例「a second device pinning the pane keeps the first page in sync」：第二个 context 用相反的视口打开同一会话，第一个页面保持与 capture-pane 逐行一致（尺寸随 pane）；期间有输出也一致；第二个关掉后第一个回到自己的尺寸，并且一致。改前红（xterm 203x47 vs tmux 56x40），改后绿。
- 单测：`session-peers.test.ts`、`viewport-ownership.test.ts` 新增 peer / released 分支。
- 全量 unit/integration + E2E 绿，CI 绿。
- dogfood：用同样的两设备脚本复测，每一步 diffRows=0；soak 后 ws/peers/subs 回到 0。

## 部署
服务端 + 前端一起发布，无配置、无数据迁移。合入后 `deploy-dogfood`，prod 由人前移 `accepted`。
