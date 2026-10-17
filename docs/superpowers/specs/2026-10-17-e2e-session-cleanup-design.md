# E2E 测试会话用完即清

- 日期：2026-10-17（RSI 第 6 轮）
- 来源：backlog P2「E2E 会话残留」，第 4、5 轮两次干扰测试

## 需求

E2E 测试结束后，它创建的会话不能留在 E2E tmux server 里。同一个 worktree 反复跑 E2E（`--repeat-each` 排查 flaky、多轮开发），会话数量不能随运行次数增长。

## 背景

E2E 的 env 文件按 checkout 持久化（`playwright.config.ts`，cwdHash），tmux server 和 hub 跨运行复用。`createSession` 走 managed launch，但从来没有人清理这些会话。每次页面加载，desktop pool 都会给每个会话开一个 ws：

- 第 4 轮：累积到 268 个会话时，attach 用例 12/12 超时；
- 第 5 轮：约 100 个会话时，每次 resize 都触发几十个 resync，诊断日志被淹没，「上次会话」的恢复也拿到了陈旧的会话。

## 设计

- `makeCreateSession` 改为返回 `{ createSession, cleanup }`。`createSession` 记录自己创建的会话名；`cleanup()` 对每个会话调用 `POST /sessions/:name/kill`，带 `x-hub-confirm: kill`，与用户点关闭按钮走同一条路径。它是 best effort：测试自己已经 kill 或改过名的会话，返回 404 也忽略；cleanup 可以重复调用。
- 两个 fixture（`fixtures.ts`、`emulator-fixtures.ts`）在 `use()` 之后调用 `cleanup()`，也就是 Playwright fixture teardown，测试失败时同样会执行。

未采用的方案：
- globalSetup 时清空整个 E2E server：会误杀并行 worker 正在用的会话，而且只在下一次运行开始时才清。
- 用 `tmux kill-session` 直接杀：绕过 hub，managed db 和 registry 要靠轮询才能发现，与用户路径不一致。

## 验收

- 单测 `tests/unit/e2e-session-cleanup.test.ts`（`Bun.serve` 模拟 hub）：cleanup 会 kill 所有创建过的会话，带 secret 和 confirm 头；容忍 404；可以重复调用。修复前 fail。
- 在同一个 worktree 连续跑两次全量 E2E（desktop + emulator），每次结束后两个 E2E server 的会话数保持在固定的小数值，不随运行次数增长（数据见 PR）。
- 全量 unit/integration 与 E2E 全绿。

## 部署与发布

只改测试，运行时代码不变。合入后 dogfood 照常部署（无行为变化）。
