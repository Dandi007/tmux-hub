# broadcaster start 期间的并发 get 与 stop（#143）

## 需求
来源：rsi meta Auditor 提交、meta 复核过的 #143。

1. `BroadcasterRegistry.get()` 被并发调用时（`session_created` 预热的同时有 ws open），第二个调用方不会等 `start()` 完成，直接拿到实例：
   - start 成功：拿到的实例 `fd === null`，attach 退化为普通 attach，没有 snapshot。
   - start 失败：拿到的是一个从没 start 成功、也不在 map 里的孤儿实例，ws 永远收不到输出。这就是 #139 修过的冻屏，换了一条路径出现。
2. `start()` 在 await tmux 期间被 `stop()`：恢复执行后照常 `openSync`、`setInterval(poll, 5)`，实例已经不在 map 里，fd、5ms 定时器和 pipe 都会永久泄漏。
3. （低优先级）desktop 同名重开在 `take()` 之后经 `setTimeout(0)` 才打开，用户在这一个 tick 内的点击取消不到。

## 设计
- registry 的 map 存 `{ b, ready }`，`ready` 就是 start 的 promise。并发调用方都 await 同一个 `ready`；失败时从 map 删除（只删同一个实例），所有调用方一起 reject。`stop`、`stopAll`、`subscriberTotal` 读 `.b`。
- `start()` 在打开 pipe 的 `pipe-pane` 返回后检查 `stopped`：如果已被 stop，再关一次 pipe（stop 的关闭可能先于我们的打开落到 tmux），然后 throw，不打开 fd，也不启动定时器。
- desktop：`take()` 挪到 `setTimeout` 回调里，和 open 在同一个 tick 内完成。
- #143 第 3 条第二项（#141 的 attach reject 分支在生产上几乎走不到）：不改代码，在 issue 里说明。

## 验收
`tests/integration/broadcaster-start-races.test.ts`（假 runner 把打开 pipe 的 `pipe-pane` 挂住）：
- 并发 get：第二个调用方拿到实例的那一刻 fd 已经不为 null，并且两个调用方拿到的是同一个实例。
- start 失败：两个调用方都 reject，registry 为空。
- start 期间 stop：start reject，fd 和 timer 都是 null，并且多关了一次 pipe。
- registry 的 stop 发生在 get 期间：get reject，registry 为空。

改动前 4 红，改动后 4 绿。全量 unit、integration 和 E2E 都要绿（含 session-recreate、fidelity 的同名重建用例）。

## 部署
合入后 deploy-dogfood，核对运行 commit；soak 加保真比对，指标回到基线。
