# tmux-hub 仓侧 /metrics 接入（tmux-hub repo）

## 体检结论（真机实测 2026-08-29）
- `tmux-hub.service`（systemd --user）运行中，`bun run src/server/main.ts`，HUB_PORT 默认 3101（127.0.0.1）。
- 无 `GET /metrics` 自指标；`/system/health` 经 authGate（有 PUBLIC_PATHS 豁免表）。
- 技术形态：Hono + Bun，模块级 `const app = new Hono()` + 顶层 `Bun.serve(...)`（导入即起服务）；
  `authGate` 中间件以 PUBLIC_PATHS 放行只读 GET。测试：`bun test`（tests/unit + tests/integration）。
- git 7 残留（.dev-dispatch，已只删不改清理）。

## 交付范围（全部落在 tmux-hub repo）
1. `src/server/main.ts`：将模块级 `app` 导出（`export const app = new Hono()`），并把 `Bun.serve({...})`
   移入 `if (import.meta.main)` 守卫（直接执行才起服务，被 import 不起）——保持生产行为不变。
   新增 `GET /metrics` 路由，返回 `text/plain` 正文 `tmux_hub_up 1`；并将 `/metrics` 加入
   `authGate` 的 PUBLIC_PATHS（只读 GET 豁免，同 `/system/auth-check` 级别），使 loopback scrape 免鉴权可达。
   要求：process-local、零依赖、不触 tmux 注册表/session 数据面，数据面异常不得令 /metrics 5xx；
   进程面存活交给 Prometheus `up` 判据。不改既有路由与鉴权行为。
2. `tests/unit/metrics.test.ts`（新增，bun test）：import `app`（不触发 Bun.serve），
   `app.request("/metrics")` 断言 200、content-type 以 text/plain 开头、正文含 `tmux_hub_up 1`；
   并断言 `GET /system/health` 仍可达（回归）。
3. 卫生：`git status --short` 为空；本单不执行部署。

## 判据对照（goal.md §判据 1-5）
1. 指标可查：`tmux_hub_up` 经 `/metrics` 暴露；
2-5. 平台侧（fleet-sentinel scrape job + 告警规则 + Grafana 面板 + drill file_sd 演练通道）
由后续 fleet-sentinel 单承接；本单只做仓侧，验收即下方命令。

```dd-acceptance
bash -lc 'bun install && bun test tests/unit/metrics.test.ts'
```