# WS 首次 attach 期间断开：不再遗留 subscriber

## 需求
人审查（2026-10-17，accepted..main 运行时代码审查）发现：`main.ts` 的 ws `open()` 依次 await pane pin、`broadcasters.get`、`attachWithReplay`（对齐循环最多 5 次 capture × 30ms）。如果客户端在这段时间断开，`close()` 会先执行、清空当时还是空的 `unsubs`；`open()` 恢复后再把 `unsubEvents` / `unsubData` push 进去，就没有人调用了。结果是每次这样的断开都会在 broadcaster 上留一个死 subscriber（以及一个 event listener），手机网络抖动时会慢慢累积。

## 设计
- 新增 `src/server/ws-attach.ts` 的 `adoptUnsubs(data, ...fns)`：连接已 closed 就立即执行这些 fn 并返回 false，否则 push 进 `unsubs`。
- `open()` 在 `await attached` 之后改用它；返回 false 时直接 return（不再发 scrollpos）。
- resize resync 路径原本已有同样的 closed 检查，不变。
- 一个检查点覆盖所有 await 窗口：`unsubEvents` 与 `unsubData` 都在这之前创建。

## 验收
- `tests/integration/ws-attach-close.test.ts`：真实 `SessionBroadcaster` + 卡住的 capture-pane，attach 期间模拟 close，恢复后 `subscriberCount()==0`。改前红（push 后 subscriber 留下），改后绿。
- 全量 unit/integration + E2E（desktop、emulator、emulator-mobile）绿，CI 绿。
- dogfood：部署后跑 soak（含快速开关页面），`tmux_hub_broadcaster_subscribers` 与 `ws_connections` 回到 0。

## 部署
只改服务端连接清理逻辑，无配置、无数据迁移。合入后 `deploy-dogfood`；prod 由人前移 `accepted`。
