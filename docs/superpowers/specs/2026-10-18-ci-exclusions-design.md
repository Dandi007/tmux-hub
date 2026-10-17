# 撤掉 CI 中的三处测试排除

## 需求（RSI loop 自定，关注点：TUI 回传与稳定性的测试覆盖）

CI 排除了 `tests/integration/hub-tui.test.ts`、`viewport-ownership.test.ts`（注释说「任何环境都失败，自 2026-07-05」）和 E2E「Ctrl+Tab / Ctrl+Shift+Tab cycles」。三者都在 TUI 区域，是覆盖空洞（backlog P2）。

## 调查

- 两个 integration 文件：在当前 main 上单独跑、并入全量跑（3 次，589 pass / 0 fail）都是绿的。中间的改动已把它们修好，排除只是没撤。
- Ctrl+Tab E2E：稳定失败（6/6）。原因在测试：tab bar 首次快照按 activity 排序（最近活跃的在前，`tab-bar.ts` refresh），测试却假设 tab 顺序等于创建顺序 a→b→c。产品行为符合设计。

## 设计

- 两个 Ctrl+Tab 用例合并为参数化用例：从渲染出的 tab bar 读实际顺序，从第一个创建的会话出发按一整圈断言（含回绕），不再假设顺序和 tab 总数。
- `ci.yml`：unit & integration 直接跑 `tests/unit tests/integration`；E2E 去掉 `--grep-invert`。

## 验收

- Ctrl+Tab 用例 `--repeat-each=5` 10/10。
- 不带任何排除的全量 unit/integration 与 E2E（desktop + emulator）全绿；CI 绿。

## 部署

只改测试与 CI，运行时代码不变；合入后照常 `deploy-dogfood`。
