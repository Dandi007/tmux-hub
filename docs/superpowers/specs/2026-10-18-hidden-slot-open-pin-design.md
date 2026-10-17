# 隐藏 pool slot 在 ws open 时不再 pin pane

## 需求（RSI loop 自定，backlog P2，第 16 轮 #128 的后续）

#128 让隐藏的 desktop pool slot 不再因窗口 resize、focus 等事件发送 resize。但服务端在 **ws open** 时仍按 URL 里的 `cols/rows` 调 `pinViewport`。桌面页面加载（以及每个隐藏 slot 重连）时，所有会话都会被 pin 到桌面尺寸：如果手机正在看会话 X，桌面一刷新，X 就被抢走。

E2E 复现：b 被「另一台设备」pin 为 100x30，桌面页面以 a 为激活 tab 加载后，隐藏的 b 变成 177x47。

## 设计

- client（`src/web/terminal.ts` `buildWsUrl`）：terminal 不可见时（`isTermVisible()`，与 `sendResizeIfVisible` 同一判定）在 URL 上加 `pin=0`。判定放在 `await hubWsUrl` 之后：pool 在开始 attach 的同一 tick 内给激活 slot 加 `is-active`，放在 await 之后才能看到。
- server（`src/server/main.ts` ws open）：
  - `pin=0` 且没有 native client：不 pin，查询 pane 实际尺寸作为 snapshot 尺寸，发 `viewport{owner:"web", 实际尺寸}`。owner 仍是 web，所以激活时的 resize 照常生效，并由 ResyncScheduler 重发对齐 snapshot。
  - 其他情况行为不变（`pin` 缺省即为 true，旧 client 兼容）。
  - 「查询 pane 尺寸」抽成 `queryPaneSize()`，与 native owner 分支共用。

## 验收

- 新 E2E「page load does not pin hidden tabs; activation does」改前红（b 变成 177x47），改后 `--repeat-each=5` 全绿；#128 的用例同时 5/5。
- fidelity oracle suite 不回归；全量 unit/integration 与 E2E 全绿。
- dogfood：先把一个会话 resize 成小尺寸，以另一个会话为激活 tab 打开桌面页面，小尺寸保持；切过去后对齐，oracle diffRows=0。

## 部署

合入后 `deploy-dogfood`；协议向后兼容（新增可选 query 参数）。
