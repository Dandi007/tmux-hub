# 同名重建的会话：broadcaster 跟着重建，打开着的页面自动重新打开

## 需求（RSI loop 自定，第 1 轮吃 dogfood 发现，P0）

2026-10-19 00:00:56，rsi driver 跨天换会话：杀掉 `rsi-meta` / `rsi-tmux-hub`，在同一秒里用同样的名字通过 `POST /sessions` 重新拉起。之后 dogfood 上这两个会话的回传**完全冻住**：浏览器 attach 拿到 snapshot（capture-pane，按名字取，是新 pane 的内容），之后再也没有字节。实测 25 秒内 xterm 一直停在 `(3m 5s …)`，tmux 已经走到 `(3m 30s …)`；`tmux list-panes` 显示两个新 pane 的 `pane_pipe=0`，只有没重建过的会话是 1。soak 的 fidelity 两个会话都报 diffRows≠0。

根因：registry 按**名字** diff，重建前后名字相同，不会发出 `session_removed`/`session_created`。`BroadcasterRegistry` 里留着挂在旧 pane 上的 broadcaster（pipe-pane 已随旧 pane 消失），`POST /sessions` 和 ws attach 调 `broadcasters.get(name)` 拿到的都是这个过期实例。hub 重启之前不会自愈。

## 设计

- `SessionInfo` 增加可选字段 `id`（tmux `#{session_id}`，例如 `$3`，在同一个 tmux server 内唯一、不复用）。`listSessions` 的 FORMAT 在名字后读取它。
- `diffSessions`：同名但 `id` 不同时，依次发出 `session_removed` 和 `session_created`。main.ts 已有的处理（removed → `broadcasters.stop`，created → `broadcasters.get`）就会重建 broadcaster，新 pane 重新挂上 pipe-pane。不需要新的服务端逻辑。
- 客户端（desktop / mobile）：`session_removed` 移除的是**当前打开**的会话时，记下名字；随后同名的 `session_created` 到达就自动重新打开它。否则 desktop 会退回到「打开 activity 最新的会话」，mobile 会回到列表，用户需要再点一次。
  - 已知代价：desktop 在 removed 与 created 之间会短暂激活另一个会话（现有的兜底逻辑），然后切回来。同名重建很少见（主要是 driver 每天一次），不为此另加状态。
- 考虑过但没做：
  - broadcaster stop 时关闭挂在上面的 ws（1012）让客户端重连：客户端在 `session_removed` 时已经会关闭这个 terminal，这样做只会让正常 kill 多出一轮重连失败的 error 日志。
  - `BroadcasterRegistry.get` 等待同名在途的 stop（担心旧 stop 的 `pipe-pane -o` 关掉新管道）：写了集成测试，修复前就是绿的，复现不了，按 YAGNI 不做。

## 验收

- 单测 `registry-diff`：同名不同 id → `[removed, created]`。
- 集成测试 `session-recreate`（真实 tmux）：kill + 同名 new-session + poll 后，旧 broadcaster 收到 `stopped`，新 pane `pane_pipe=1`，订阅者能收到新 pane 的输出。修复前红。
- E2E fidelity oracle（emulator + emulator-mobile）新增「同名重建后页面继续流式」：页面打开着时 kill + 同名 new-session，新输出后 xterm == capture-pane。`expectInSync` 额外要求 probe 可见。只去掉服务端修复时稳定红（xterm 冻在 before 行）；只去掉客户端修复时在全量运行中红（`visible=false`，tab 被换到另一个会话）。
- dogfood：部署后两个 CC 会话 soak fidelity ok。

## 部署

dogfood 正常 `deploy-dogfood`。hub 重启会重建所有 broadcaster，所以现在冻住的两个会话部署后就会恢复；验证要靠再做一次同名重建（临时会话）。
