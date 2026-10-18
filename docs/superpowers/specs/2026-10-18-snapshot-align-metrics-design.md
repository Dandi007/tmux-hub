# attach/resync snapshot 对齐结果计数进 /metrics

## 需求
人审查 backlog P2「对齐退回旧逻辑的频率不可见」：`attachWithReplay` 的对齐循环（ALIGN_SETTLE_MS=30，最多 5 次 capture）在 pane 一直有输出时会放弃对齐，把最后一次 capture 连同重叠字节一起发出（可能导致错位），但只打 debug 日志，无法知道线上发生得多频繁。CC 会话在工作时 spinner 持续刷新，这条路径在真实使用中是否常见，需要数据来回答。

## 设计
- `output-broadcaster.ts` 导出进程级 `snapshotStats = { snapshots, retries, overlaps }`：每次 emulator snapshot 发出时 `snapshots++`；因在途字节重新 capture 时 `retries++`；用完次数仍不安静、带重叠发出时 `overlaps++`。attach 和 resync 共用这条路径，两者都计入。
- `/metrics` 增加三个 counter：`tmux_hub_snapshots_total`、`tmux_hub_snapshot_retries_total`、`tmux_hub_snapshot_overlaps_total`。`renderMetrics` 的条目增加可选 `type`（默认 gauge），counter 输出 `# TYPE … counter`。
- 不改变对齐行为本身；先有数据，再决定要不要调整 ALIGN 参数。

## 验收
- 集成测试 attach-snapshot-alignment：安静 pane → snapshots+1、retries+0；有在途字节 → retries+1；从不安静 → overlaps+1、retries=captures-1。改前红，改后绿。
- 单测：renderMetrics 渲染 counter；`/metrics` 包含三个新指标。
- dogfood：部署后打开 CC 会话（工作中）若干次，读取三个 counter，记入 journal 作为基线。

## 部署
只增加计数与指标，无配置、无行为变化。合入后 `deploy-dogfood`。
