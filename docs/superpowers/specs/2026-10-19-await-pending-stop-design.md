# 同名重建时，新 start 等旧 stop 完成

## 需求
来源：#140 里 Auditor 的疑似项（backlog P3），本轮读代码确认。rsi driver 每天 00:00 会 kill 会话并同名重建，registry 会在同一次 poll 里依次发出 `session_removed` 和 `session_created`。`SessionRegistry.emit` 不 await 监听器，所以 main.ts 里旧 broadcaster 的 `stop()` 和新 broadcaster 的 `get()` 会交错执行：

- 旧 stop 在 await `pipe-pane -o`（关 pipe）之后才执行 `trashLog`。新 start 的 touch log 和打开 fd 如果先于它完成，新 log 就会被移进 `.trash`。读写两端都跟着 inode 走，画面不会冻住，但 logPath 上已经没有文件，hub 重启后这段历史就丢了。
- 旧 stop 的关 pipe 是一个独立的 tmux 进程，如果它落在新 start 的打开 pipe 之后，会把新会话的 pipe 关掉，导致冻屏。概率低，但后果更重。

## 设计
- `BroadcasterRegistry` 增加 `stopping: Map<session, Promise<void>>`，记录在途的 stop。
- `get()` 新建实例时，先 await 同名在途的 stop，再 start；并发的 get 仍然共用同一个 `ready`（#143）。
- 存进 `stopping` 的 promise 无论成败都会 settle，旧 stop 失败不会连带新 start 一起失败；settle 后自己从 map 里删除（只删自己那一个）。

## 验收
在 `tests/integration/broadcaster-start-races.test.ts` 新增一个用例：用假 runner 挂住旧 stop 的关 pipe，期间发起同名 get，再放行。断言调用顺序是旧 close 完成，然后才是新的 close 和 open；并且 logPath 仍然存在（被移进 .trash 的是旧 log）。改动前红，改动后绿。全量 unit、integration、E2E 都要绿。

## 部署
合入后 deploy-dogfood，核对运行 commit。在 dogfood 上用临时会话 kill 后立即同名重建，确认新会话的 pane_pipe=1、log 文件存在、页面持续回传。
