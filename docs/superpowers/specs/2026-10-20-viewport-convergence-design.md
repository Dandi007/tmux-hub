# 多浏览器 viewport 更新收敛

## 1 第一性原理：要什么

两台设备同时查看并调整同一会话时，每页最终采用 tmux 已应用的同一尺寸，输出停止及布局稳定后屏幕与 capture-pane 一致。保留原有最近操作设备 pin、其他设备跟随、pinning 设备离开后可见页面收回的行为。原生 tmux client 优先权不变。

## 2 现状与根因

RSI 第 22 轮在 dogfood aa87de2 上执行 16 次双页面并发 resize，15 次尺寸不一致；最后静置 3.5 秒后 pane166x44、桌面66x39，差44行。现有 resize 不串行，tmux 副作用顺序和异步完成通知顺序可交错。即使副作用串行，页面仍可能在自己的请求完成前采用另一页的旧通知，自身应用后没有确认消息来恢复。首次 attach 完成前才加入 SessionPeers，也会漏收期间发生的尺寸更新。

## 3 方案设计

```text
open pin / resize → 每会话 viewport 队列 → tmux 完成 → 同一队列内发布应用尺寸
                                                 ├─ 发起页 applied 确认
                                                 └─ 其他页 peer 通知
                                                      ↓
                                            xterm 采用尺寸 + aligned resync
```

队列只包括初始 ownership/query/pin 和 WS resize 的执行与通知，不包含 snapshot、普通按键或长输入；不同会话独立，失败不会阻塞后续操作，空闲队列移除。等待中的已关闭连接不再执行 pin/resize；已开始的 pin 在关闭后完成仍沿用 released/reclaim 处理。

viewport 协议增加可选 `applied: true`：发起页也采用服务端应用后的尺寸，不再忽略确认；原有 peer/native/released 含义保持。旧页面可以忽略该可选字段，升级后页面恢复完整保证。

InputRouter 仅在 resize-window 成功时返回应用尺寸，失败沿用 HubError 路径（会话不存在为410、其他失败500），不能把请求尺寸错误发布为已应用的确认。此前该分支仅 warn 后仍返回尺寸，需要随新增确认一起修正。

连接 open 时即加入 peers。每个连接保存最近收到的权威 viewport，获取 broadcaster 后以最新尺寸 attach；attach 中的变更交给其 ResyncScheduler 排在初始回放后执行，即使期间尺寸变更后又回到原值也保留 dirty 标记。失败和关闭路径释放 peers/listeners/定时器；不等待 snapshot 持有 viewport 队列。

## 4 改动清单

| 文件 | 改动 |
| --- | --- |
| src/server/ws-handlers.ts | 按会话串行 pin/resize 与发布；pending attach 注册及尺寸追平 |
| src/server/input-router.ts | resize 失败不返回未应用的尺寸，保留 session-gone 错误 |
| src/shared/protocol.ts | applied 可选确认字段 |
| src/web/viewport-owner.ts | 应用自身确认尺寸 |
| src/web/terminal.ts | 初始 open 的延迟尺寸发布前重新 fit，避免确认把 renderer 测量后的尺寸覆盖为初始值；隐藏页仍不发布 |
| tests/integration/ws-handlers.test.ts / ws-viewport.test.ts | 保持关闭清理回归，增加受控并发/attach/失败恢复测试 |
| tests/unit/viewport-ownership.test.ts | applied 确认采用行为 |
| tests/unit/input-router-resize.test.ts | resize 失败及后续成功、会话删除错误 |
| tests/e2e/fidelity-suite.ts | 双页并发 resize 后两页尺寸/屏幕均等于 tmux |

## 5 测试及验收

先添加生产 WS handlers 和真实 localhost WebSocket 的失败测试，受控依赖仅控制 tmux/input/attach 完成时序，客户端采用真实 viewport reducer。覆盖串行副作用与通知、双方权威确认、attach 期间更新、不同会话独立、失败和关闭后的队列恢复/清理。E2E 通过真实两浏览器 viewport 调整检查用户屏幕，不注入实现状态。

执行 build、lint:tests、全部 unit/integration 与 desktop/emulator E2E，补 emulator-mobile 保真；使用隔离环境和独立 socket。PR 与合入后 push CI 分别按 exact SHA 验证 completed/success；随后仅部署 dogfood，重跑第22轮16次双浏览器验收，要求全部稳定采样尺寸一致、diffRows=0，并查看截图、清理专属 session。

## 6 边界与部署条件

本次不改语音、prod、harness 或原生客户端控制路径。不把各设备独立尺寸作为目标：tmux window 始终只有一个尺寸。瞬间交错输出通过现有 aligned resync 在布局稳定后收敛。部署沿用已授权 deploy-dogfood；单次 readiness 检查的已有 P2 独立处理，本 PR 不混入该修复。
