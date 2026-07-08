# Desktop Ctrl/Cmd+Shift+Tab 反向切换 Tab 设计

## §1 第一性原理：要什么

在前一版 `Ctrl/Cmd+Tab` 正向循环切换 tab 的基础上，用户希望增加反向循环：`Ctrl/Cmd+Shift+Tab` 切换到上一个 tab，行为与浏览器标签页一致。

验收标准：

- 在 desktop view 下，按 `Ctrl+Shift+Tab` 或 `Cmd+Shift+Tab` 切换到当前 tab 的上一个 tab（循环到最后一个）。
- 不影响现有 `Ctrl/Cmd+T`、`Ctrl/Cmd+W`、`Ctrl/Cmd+1-9`、`Ctrl/Cmd+Tab` 的行为。
- 继续通过 capture phase 拦截，避免把 `Tab` 字符发送给远端 pane。

## §2 现状与根因

当前 `desktop-view.ts` 的快捷键守卫为：

```ts
if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
```

这导致任何带 `Shift` 的 chord 都会被提前过滤掉，无法支持 `Ctrl+Shift+Tab`。`tab-bar.ts` 也只有 `getNextSession()`，没有取上一个 tab 的 API。

## §3 方案设计

1. 调整守卫：仅当 `e.shiftKey` 为真且按键不是 `Tab` 时才返回，允许 `Shift+Tab` chord 进入后续分支。
2. 在 `TabBarHandle` 新增 `getPrevSession(currentName)`，内部按 `orderedSessions` 顺序找上一个，到开头则回到最后一个。
3. 在 `e.key === "Tab"` 分支中根据 `e.shiftKey` 选择 `getPrevSession` 或 `getNextSession`。

## §4 改动清单

| 文件 | 改动 |
|---|---|
| `src/web/desktop/tab-bar.ts` | 新增 `TabBarHandle.getPrevSession(currentName)` |
| `src/web/desktop/desktop-view.ts` | 允许 `Ctrl/Cmd+Shift+Tab`，反向循环切换 |
| `tests/e2e/desktop.e2e.ts` | 新增 E2E 测试：Ctrl+Shift+Tab 反向循环切换 tab |
| `docs/superpowers/specs/2026-07-08-desktop-ctrl-shift-tab-prev-design.md` | 本设计文档 |

## §5 测试计划

- `npx playwright test tests/e2e/desktop.e2e.ts` 验证新增用例与既有桌面 tab-bar 用例。
- `bun run build` 确保构建无类型错误。

## §6 非目标

- 不新增 UI shortcut hint。
- 移动端不新增此快捷键。
- 不改变 `Ctrl/Cmd+Tab` 的正向循环逻辑。
