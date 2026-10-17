# dogfood attach/detach soak 脚本

## 需求（RSI loop 自定，backlog P1「oracle 扩展」与 P2「长时间稳定性观测」）

第 10 轮给 `/metrics` 加了连接与进程 gauge，但判断「有没有泄漏」仍靠手工 curl、肉眼比较。需要一个可重复运行的 soak：反复冷 attach、切 tab、reload、resize、断开之后，自动判定连接生命周期是否泄漏，并顺带验证所有会话的画面保真。第 15 轮先在 scratchpad 里手工跑了 40 轮和 150 轮，确认这个方法有效。

## 设计

- `scripts/diag/soak-judge.ts`（纯函数，可单测）：
  - `parseMetrics(text)`：读 Prometheus text 格式。
  - `judgeSoak(base, end)`：ws、SSE、subscriber 必须回到基线；fd 不能比基线高出 2 个以上（允许少量抖动）；broadcasters 必须等于 sessions；缺少某个 gauge 时报问题，不能静默通过。
- `scripts/diag/soak.ts`（与已有的 `iphone-probe.ts`、`probe-resize.ts` 同目录，同为 headless Playwright 诊断脚本）：
  - 每轮新建一个 browser context，冷 attach desktop pool 里的每个 tab；按轮次轮换 Ctrl+Tab、reload 和 resize（视口尺寸也轮换），然后关闭 context。
  - 每 10 轮打印一次 RSS、heap、fd、ws、SSE、subs 和 broadcaster 数，作为曲线。
  - 给了 `--socket` 时，最后逐个 tab 用 `?debug=term` probe 比对 xterm 可见屏与 `capture-pane`。
  - 发现任何问题时退出码为 1。
- 不进 CI：它针对的是正在运行的实例（dogfood/prod），而不是测试 server。

## 验收

- 单测：基线干净、各类泄漏、fd 抖动容忍与漂移、broadcaster 与 session 不一致、gauge 缺失。
- dogfood：`bun run scripts/diag/soak.ts --cycles 10 --socket hub-dogfood` 退出码 0，两个会话 fidelity ok。
- 全量 unit/integration 与 E2E 不回归。

## 部署

只新增诊断脚本与单测，运行时代码不变。
