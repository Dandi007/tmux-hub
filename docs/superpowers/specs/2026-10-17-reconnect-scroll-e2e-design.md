# reconnect 滚动恢复的 E2E 覆盖

- 日期：2026-10-17（RSI 第 7 轮）
- 来源：backlog P1「reconnect 滚动恢复没有 E2E 覆盖」（第 5 轮发现）

## 需求

scroll-restore 的 reconnect 路径（`src/shared/scroll-restore.ts` 的 INV-1/INV-3，`terminal.ts` 的 `saveLocalLfbForReplay` 和 scrollpos barrier）要有 E2E 守住：
- 断线前向上翻着的，重连后回到同一位置；
- 断线前跟底的，重连后仍跟底，并且能看到断线期间产生的输出。

这之前只有 `decideScrollRestore` / `snapshotLocalLfb` 的纯函数单测。真实的 ws 断线、RIS 加 snapshot、parse barrier 这条链路没有任何覆盖。

## 设计

- `tests/e2e/fidelity-suite.ts` 新增用例「reconnect restores a scrolled-up viewport and keeps a bottom one at the bottom」，挂在 emulator project 上，复用第 5 轮的 probe（`scrollLines` / `linesFromBottom` / `dropSocket` / `visible`）。
- probe 新增 `replays`：每次 scrollpos 的 parse barrier 执行完就 +1（恢复决策已执行或已挂起）。原因是 ws open 时 state 就变成 connected，而 replay 和恢复要稍后才到。如果只看 state，测试会在恢复完成前进入下一步：诊断中 15 次失败 2 次，失败时用户态的滚动被挂起的恢复按 INV-4 的设计覆盖了。测试改为等 `replays` 增加。
- 只改 `?debug=term` probe 和测试，产品行为不变。

## 验收

- 新用例 `--repeat-each=20` 20/20 通过（加 `replays` 等待之前是 13/15，失败原因见上）。
- 全量 unit/integration 与 E2E（desktop + emulator）全绿。

## 部署与发布

probe 只在 `?debug=term` 下生效，运行时行为不变。合入后照常部署 dogfood。
