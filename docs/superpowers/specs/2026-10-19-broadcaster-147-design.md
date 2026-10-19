# broadcaster：start 读阶段失败释放 fd/pipe；连续重建串起在途 stop（#147）

## 需求

Auditor issue #147 指出三处问题（复核确认，都是低概率）：

1. `start()` 打开 fd 之后，#146 新加的 `fstatSync` 和 `readSync` 如果抛错，`start()` 会 reject，但 `this.fd` 不关，已打开的 pipe-pane 也不关。registry 的失败分支只把实例从 map 删掉，这个实例就没人持有了：fd 一直泄漏，pipe 一直往日志里写。
2. `BroadcasterRegistry.stopping` 只记最新一次 stop。连续重建时（stop(old) 挂起 → get 出 b2 → stop(b2) → get 出 b3），b3 只等 b2 的 stop。old 的关 pipe 或 trashLog 仍可能落在 b3 的 pipe 和日志上，这正是 #145 要堵的窗口。
3. 尾部 prime 的 `readSync` 没有看返回值。短读时会把多余的 0 字节送进 title filter（影响可忽略）。

## 设计

1. `start()` 中 `openSync` 之后的读取放进 try。失败时 close fd、置 null、`pipe-pane -o` 关掉刚打开的 pipe，再把错误抛出。poll timer 在 try 之后才建，失败路径上不存在。
2. `stop()` 登记在途 stop 时串上前一个：`settled = prior.then(() => stopped)`，仍然无论成败都会 settle。后来的 get 会等到同名所有更早的 stop 都完成。
3. 只把实际读到的 `tail.subarray(0, n)` 送进 filter。

## 验收

`tests/integration/broadcaster-start-races.test.ts` 新增两个用例：

- 连续两次同名 stop（第一次的关 pipe 被挂住）之后再 get：第三个实例打开 pipe 一定发生在第一次 stop 完成之后。改动前红。
- 日志路径是目录（`readSync` 抛 EISDIR）：start reject，fd 与 timer 都是 null，进程 fd 数不变，tmux 调用顺序为 close、open、close。改动前红。
- 第 3 条无法稳定复现短读，不单独写用例，由现有 tail 用例覆盖正常路径。

全量 unit + integration + E2E 绿。dogfood 部署后 soak 保真 ok，同名 kill 后立即重建的会话正常回传。

## 部署

合入后 `deploy-dogfood`；prod 由人类前移 `accepted` 决定。
