# start 失败的 broadcaster 不再缓存

## 需求（RSI loop 自定，backlog P3，第 34 轮在 E2E 日志里发现）

`BroadcasterRegistry.get(name)` 先把新实例放进 map，再 `await start()`。start 失败（`pipe-pane` 报 `can't find session`：会话还没出现或刚被 kill，客户端在收到 `session_removed` 之前重连就会遇到）时，实例留在 map 里。之后同名的 `get()` 直接返回这个没挂管道的实例，这个名字的会话就永远收不到输出（与 #138 同一类冻屏），直到 registry 发出 removed 把它 stop 掉。如果会话在 registry 发现它消失之前就以同名回来（#138 的场景，或者 kill 后立刻重建），就会一直冻住。

## 设计

`get()` 里 start 抛错时，从 map 删掉这个实例（只删自己：防止期间有人 stop 后又放进了新实例），然后重新抛出。调用方的行为不变（ws 收到 1011 并重连，main 的 prime 打日志）。

日志级别不调整：`pipe-pane failed` 仍是 error，噪声问题另议。

## 验收

- 集成测试（真实 tmux）：对不存在的会话 `get()` 抛错且 `size()==0`；随后创建会话，再次 `get()` 后 `pane_pipe=1`，订阅者能收到输出。修复前 `size()==1`。
- 全量测试与 dogfood soak 通过。

## 部署

dogfood `deploy-dogfood`。
