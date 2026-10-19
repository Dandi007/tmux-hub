# 删除 broadcaster 的 RingBuffer

## 需求

`SessionBroadcaster.ring` 是一个 1MB 的环形缓冲（`TMUX_HUB_RING_BUFFER_BYTES`），每个会话一份，所有 live 字节都要写一遍。它的内容从来没有被读过（不 dump）：

- attach 回放走 emulator snapshot（capture-pane）。
- legacy replay 与 emulator prime 直接从日志 fd 读尾部。

ring 还剩两个用处：

- `bytesBroadcast()` 计数：测试用来等首个字节。
- `truncated()` 标志：ws attach 时据此发 SSE `replay_truncated`。可是没有任何客户端（`src/web`、其他仓库）消费这个事件，而且 #146 之后这个标志只是「日志大于 1MB」的近似。

YAGNI，删除优先：

- 每个活跃会话省下约 1MB 常驻内存。
- 每个 live chunk 少一次拷贝。
- 少一个 env 开关。

## 设计

- 删 `src/server/ring-buffer.ts` 与它的单测 `tests/unit/ring-buffer.test.ts`（被测代码已不存在）。
- `bytesBroadcast()` 改为一个普通计数器，emit 时累加。
- 删 `RING_BUFFER_BYTES` 配置。部署的 env 文件与其他仓库都没有设置它（已检索）。
- 删 ws attach 时基于 ring 标志发 `replay_truncated` 的那一行。

保留 `BroadcasterEvent` 的 `replay_truncated`（日志被截短时由 poll 发出），以及 ws-handlers 对它的转发：

- 它是 ws 侧唯一的 broadcaster 事件订阅。
- #133/#135 的回归测试靠这个订阅的释放来断言 listener 不泄漏，删掉会让那些断言变空。

## 验收

- `tests/integration/broadcaster-start-at-tail.test.ts` 去掉对 `ring.truncated()` 的两处断言（概念已删除）。新增回归用例：日志被截短时发 `replay_truncated`，之后从新末尾继续广播。
- 全量 unit + integration + E2E 绿。
- dogfood：部署后 soak 保真 ok，fd/ws/subs 无泄漏。

## 部署

合入后 `deploy-dogfood`；prod 由人类前移 `accepted` 决定。
