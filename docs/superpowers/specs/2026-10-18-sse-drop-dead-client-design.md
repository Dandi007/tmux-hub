# SseHub：enqueue 抛错时移除 client

- 日期：2026-10-18（RSI 第 23 轮，backlog P3）

## 需求

`SseHub.emit` 对每个 client 调用 `controller.enqueue`。如果某个 stream 已关闭或出错，但 `cancel` 没有被调用，enqueue 会抛错。目前的代码只吞掉这个异常，client 会留在集合里，之后每次 emit 都会再抛一次。`/metrics` 的 `tmux_hub_sse_clients` 也会因此虚高，掩盖真正的泄漏。

## 设计

在 catch 分支里把该 client 从集合中删掉，一行改动。在 `Set` 迭代过程中删除当前元素是安全的（JS 的 Set 迭代语义保证这一点）。

## 验收

- 新单测 `tests/unit/sse-hub.test.ts`：两个 client，其中一个的 enqueue 抛错。emit 之后 `clientCount()` 为 1，另一个 client 仍能收到事件（改动前这条测试是红的）。
- 同时覆盖 `cancel` 会移除 client。
- 全量 unit、integration 和 E2E 都是绿的。

## 部署

合入后部署 dogfood，确认 health 正常、`/metrics` 的 `sse_clients` 随页面打开和关闭归零。行为上对用户没有可见变化。
