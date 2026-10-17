# 清理测试代码中的 tsc 类型错误（语音除外）

## 需求（RSI loop 自定，backlog P2）

`bunx tsc --noEmit` 报 44 个错误；CI 不跑 tsc，所以没暴露。错误掩盖了真实的类型约束，比如 oracle 的 probe 类型和 `src/web/terminal.ts` 的 `TerminalProbe` 各写一份，两边已经漂移，测试里只好靠 `as unknown as` 强转。分布：

| 文件 | 数量 | 原因 |
|---|---|---|
| `tests/e2e/fidelity-suite.ts` | 22 | 自己 `declare global` 了一份过时的 `__tmuxHubTerms` 类型，与 terminal.ts 冲突；`TestType<{ctx}>` 缺 `page` fixture，回调参数退化为 any |
| `tests/unit/hub-tui.test.ts` | 13 | `SessionInfo` 新增必填字段 `pane_title` 后，fixture 没跟上 |
| `tests/unit/registry-diff.test.ts` | 1 | 同上 |
| `tests/unit/image-upload-client.test.ts` | 1 | `mock` 直接断言成 `typeof fetch` |
| `src/server/voice-routes.ts`、`tests/unit/voice-store.test.ts` | 7 | 语音，按 loop 授权不碰 |

## 设计

- fidelity-suite：删掉本地的 `Probe` 与 `declare global`，改为 `import type { TerminalProbe }`；suite 参数类型改为 `TestType<PlaywrightTestArgs & { ctx }, PlaywrightWorkerArgs>`；能直接用 `TerminalProbe` 字段的地方去掉 `as unknown as`（按 key 动态取值的那一处保留）。
- 其余三个文件：fixture 补 `pane_title: ""`；`as unknown as typeof fetch`。
- 运行时代码不变。

## 验收

- `bunx tsc --noEmit` 只剩 7 个语音错误（改前 44 个）。
- 全量 unit/integration 与 E2E 不回归（含 fidelity suite）。

## 后续（不在本 PR）

语音的 7 个错误修好后，可以在 CI 加 `tsc --noEmit` 关卡，防止再积累。

## 部署

只改测试，合入后照常 `deploy-dogfood`。
