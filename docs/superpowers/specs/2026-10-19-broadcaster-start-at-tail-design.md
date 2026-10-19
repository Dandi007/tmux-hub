# broadcaster start 从日志末尾开始读

## 需求

`SessionBroadcaster.start()` 把 `offset` 置 0，第一次 poll 会在一个 tick 里同步读完整份会话日志，并逐块过 `TitleSeqFilter` 与 `RingBuffer`。会话日志只追加、不轮转，长期运行的会话会越来越大：

- dogfood 的 `rsi-tmux-hub.log` 7 小时涨到 24MB；prod 最大的单个日志 64MB。
- 实测同一路径的耗时约 12ms/MB：24MB 约 290ms，64MB 约 750ms，跑一个月的繁忙会话（约 2.4GB）约 30 秒。
- hub 启动时给每个会话都立即建 broadcaster（`main.ts` 启动 reconcile），所以每次重启都要按全部日志的总大小阻塞事件循环，期间 HTTP、WS、SSE 都不响应。

读出来的历史没有人用：

- ring 的内容从不 dump，只剩 `truncated()` 标志（ws 用于发 `replay_truncated`）和 `bytesBroadcast()` 计数。
- emulator 的 prime 和 legacy replay 都按 offset 直接从 fd 读尾部，不经过 poll。

## 设计

`start()` 打开 fd 后：

1. `offset = fstat(fd).size`，只广播 start 之后的新字节。
2. 文件大于 ring 容量时 `ring.markTruncated()`，与原先读满时的标志保持一致（新增 `RingBuffer.markTruncated()`）。
3. 把文件最后 2KB 喂给 `TitleSeqFilter`，丢弃输出，让它的状态与 EOF 对齐。窗口名序列在过滤器里最长 1024 字节，所以断在 EOF 处的 `ESC k …` 的开头一定在这 2KB 内，它的后半截仍会被剥掉。

不改 emulator prime、legacy replay、attach 对齐等路径（它们按 fd 的绝对位置读，offset 含义不变）。

日志本身不轮转（磁盘增长）是另一个问题，记入 backlog，本 PR 不处理。

## 验收

- `tests/integration/broadcaster-start-at-tail.test.ts`：
  - 4MB 已有日志：start 后 `bytesBroadcast()==0`，subscriber 没收到历史；ring 标记 truncated；追加的新字节原样送达。
  - 小日志：不标记 truncated。
  - 日志在 `ESC k pri` 处断开，追加 `ntf ESC \ hello\n`：subscriber 只收到 `hello\n`。
  - 改动前 3 红，改动后 3 绿。
- 全量 unit + integration + E2E 绿。
- dogfood：部署后启动日志里各会话 `broadcaster started` 正常，回传保真 soak ok，attach 后历史（emulator snapshot）正常显示。

## 部署

合入后 `deploy-dogfood`；prod 由人类前移 `accepted` 决定。
