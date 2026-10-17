# 服务端 emulator（xterm-headless）改用 Unicode 11 宽度表

## 需求（RSI loop 自定，关注点：TUI 回传保真）

第 9 轮（PR #122）已让浏览器端 xterm 加载 Unicode 11 宽度表，与 tmux 3.6、Claude Code（Ink）一致：⚡💬 这类 emoji 占 2 列。服务端的 `SessionEmulator`（`@xterm/headless` 6.0.0）仍是默认的 Unicode 6，同一字节流在它这里 emoji 只占 1 列。

影响：emulator 的 `snapshot()` 是 capture-pane 失败时的 fallback 恢复流；它算错宽度时，按绝对列号重绘（CHA/CUP）的 TUI 会在 snapshot 里错位，attach 后浏览器屏幕与 tmux 不一致。平时只用它跟踪 modes，影响面小，但三方宽度表应统一。

## 设计

- 依赖：`@xterm/addon-unicode11@0.9.0`（与 `@xterm/headless@6.0.0`、`@xterm/addon-serialize@0.14.0` 同一发布线，钉精确版本）。
- `SessionEmulator` 构造时 `loadAddon(new Unicode11Addon())` 并设 `term.unicode.activeVersion = "11"`（headless 构造时已开 `allowProposedApi`）。

## 验收

- 单测：写入 `⚡` + `ESC[3G` + `y`，snapshot 中 `⚡y` 相邻（Unicode 6 下会是 `⚡ y`）。改前红，改后绿。
- 全量 unit/integration 与 E2E 不回归。
- dogfood：部署后 health 中的 commit 一致；对含 emoji 的会话用 oracle 比对 attach 后的屏幕，diffRows=0。

## 部署

合入 main 后 `deploy-dogfood`；不涉及 prod。
