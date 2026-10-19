# ws 中途关闭的副作用收口（#135）

## 需求
来源：rsi meta Auditor 提交、meta 复核过的 #135（含补充评论）。ws 在 `open()` 或 resize 的 await 期间被关闭（手机弱网很常见）时：

1. `open()` 在 `getNativeAttachCount` 之后、`broadcasters.get` 之后都不检查 `closed`，会继续 pin pane、capture、attach，白白做完这些工作。
2. `pinnedBy` 不检查 `closed`：`close()` 已经执行过 `peers.remove`，pin 返回后又把已关闭的 ws 写进 `pinner`，并向其他页面发 `peer:true`。其他页面会缩到一个已不存在的 client 的尺寸，**永远收不到 `released`**（这正是 #136 要修的症状），`pinner` map 也一直留着这个 ws 的引用。open 和 resize 两条路径都有这个问题。
3. `await attached` reject 时，`onEvent` 注册的 listener 永久泄漏，open 抛出未处理的异常。
4. #133 的回归测试是手动模拟 close，没有经过真实的 handler 接线。

## 设计
- 把 `main.ts` 里的 websocket handlers 原样搬进 `src/server/ws-handlers.ts` 的 `createWsHandlers(deps)`，tmux、broadcaster、pin、db、input、logger 都通过参数注入；`main.ts` 只做接线。第一个 commit 是纯搬移，不改行为。
- `open()`：`getNativeAttachCount` 之后、`broadcasters.get` 之后各加 `if (ws.data.closed) return;`。
- `pinnedBy`：如果 ws 已关闭，不记录 pinner，也不发 `peer:true`，改为向其他页面发 `released`。tmux 那边的尺寸已经被改了，而 `close()` 已执行完、不会再发 released，让其他页面走已有的 reassertViewport 把尺寸收回来。关闭时的 released 抽成同一个 `released(ws)`。
- `await attached` 失败时：取消 `unsubEvents`，记 error，用 1011 关闭 ws。

## 验收
`tests/integration/ws-handlers.test.ts`：用真实的 `Bun.serve` 和 WebSocket client 连 `createWsHandlers`，依赖用假实现，配合 gate 控制时序：
- 在检查 native client 期间关闭：不 pin，不取 broadcaster。
- 在 pin 期间关闭（另有页面 A）：A 最后收到的 viewport 是 `released`，不是 `peer`；A 关闭后 peers 为空。
- 在 resize 期间关闭：A 最后收到的是 `released`。
- 在 attach 期间关闭（真实的 SessionBroadcaster）：subscriber 回到 0（#133 的真实接线回归测试）。
- attach reject：listener 为 0，ws 以 1011 关闭。

改动前 4 红 1 绿（#133 的那一条本来就已修复），改动后 5 绿。全量 unit/integration/E2E 都要绿。

## 部署
合入后 deploy-dogfood，核对运行 commit；在 dogfood 打开页面确认 attach、回传和 resize 正常，`/metrics` 的 ws/peers/subscribers 都回到 0。
