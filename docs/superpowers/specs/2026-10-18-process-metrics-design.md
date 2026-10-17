# /metrics 增加进程级与连接级 gauge

## 需求（RSI loop 自定，关注点：系统稳定性）

backlog P2「长时间稳定性观测」：要判断 dogfood bun 进程是否存在内存或 fd 泄漏、连接或订阅是否只增不减，目前只能手工读 `/proc/<pid>/status`。`/metrics` 只有 `tmux_hub_up 1`，无法连续采样，也无法区分「浏览器 attach 带来的正常增长」和「泄漏」。

## 设计

- 新模块 `src/server/metrics.ts`：`renderMetrics(gauges)` 按 Prometheus text format 输出 `# HELP` / `# TYPE gauge` / 值。每个 gauge 的取值函数单独 try/catch；抛错或返回 `undefined` 的 gauge 整个省略，`tmux_hub_up 1` 永远在第一行。保持原有约定：`/metrics` 不因数据面故障 5xx。
- `openFdCount()`：读 `/proc/self/fd` 的条目数，非 Linux（macOS prod）返回 `undefined`，即省略该指标。
- 指标（全部是进程内内存读数，不调用 tmux）：

| 名称 | 含义 |
|---|---|
| `process_resident_memory_bytes` | `process.memoryUsage().rss` |
| `process_heap_used_bytes` | JS heap used |
| `process_open_fds` | `/proc/self/fd` 条目数（仅 Linux） |
| `process_uptime_seconds` | `process.uptime()` |
| `tmux_hub_sessions` | registry 内存快照中的会话数 |
| `tmux_hub_ws_connections` | 当前打开的终端 websocket 数（open +1，close −1） |
| `tmux_hub_sse_clients` | 当前 SSE 客户端数 |
| `tmux_hub_broadcasters` | 活着的 SessionBroadcaster 数 |
| `tmux_hub_broadcaster_subscribers` | 所有 broadcaster 的数据订阅者总数 |

泄漏判据：ws/SSE 全部断开后，`tmux_hub_broadcaster_subscribers` 应回到 0（emulator tap 除外，tap 在 attach 结束即移除）；`broadcasters` 应等于 `sessions`。

- `/metrics` 仍是公开只读（auth 白名单不变）。只暴露计数，不暴露会话名、路径或任何凭据。

## 验收

- 单测：`renderMetrics` 的格式、抛错 gauge 被省略；`GET /metrics` 含上述指标，RSS > 0，Linux 上 fd > 0，未连接时 ws=0。
- dogfood：部署后 `curl /metrics` 能看到全部指标；打开浏览器 attach 一个会话后 ws/subscribers 增加，关闭后回落。

## 部署

合入 main 后 `deploy-dogfood`。不涉及 prod；prod 由人类前移 `accepted` 时带上。
