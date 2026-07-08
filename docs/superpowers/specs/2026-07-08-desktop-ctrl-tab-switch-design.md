# Desktop Ctrl/Cmd+Tab 切换 Tab 设计

## §1 第一性原理：要什么

桌面端 tmux-hub 的 tab bar 已经支持点击切换、Ctrl/Cmd+1-9 跳转指定 tab。用户在 NUC（Windows/Linux 桌面/PWA）部署场景下，希望用更直觉的 `Ctrl+Tab`（macOS 上对应 `Cmd+Tab`）循环切换到下一个 tab，提升键盘操作效率。

验收标准：

- 在 desktop view 下，按 `Ctrl+Tab` 或 `Cmd+Tab` 切换到当前 tab 的下一个 tab（循环到第一个）。
- 快捷键在 xterm 捕获键盘前被拦截，避免把 `Tab` 字符发送给远端 pane。
- 与现有 `Ctrl/Cmd+1-9`、`Ctrl/Cmd+T`、`Ctrl/Cmd+W` 不冲突。

## §2 现状与根因

`src/web/desktop/desktop-view.ts` 已在 capture phase 监听 `document.keydown`，处理：

- `Ctrl/Cmd+T`：新建 session
- `Ctrl/Cmd+W`：关闭当前 session
- `Ctrl/Cmd+1-9`：切换到第 N 个 tab

但缺少循环切换到下一个 tab 的能力。`tab-bar.ts` 暴露了 `getSessionAt(index)`，但没有暴露“基于当前 active name 取下一个”的 API。

## §3 方案设计

1. 在 `TabBarHandle` 新增 `getNextSession(currentName: string): string | undefined`，内部按当前 `orderedSessions` 顺序找下一个，到末尾则回到第一个。
2. 在 `desktop-view.ts` 的 `handleShortcuts` 中增加 `e.key === "Tab"` 分支，要求 `(ctrlKey || metaKey)`、无 shift/alt，调用 `openSession(nextName)`。
3. 使用 `e.preventDefault()` + `e.stopPropagation()` 阻止事件继续传给 xterm 或浏览器默认行为。

## §4 改动清单

| 文件 | 改动 |
|---|---|
| `src/web/desktop/tab-bar.ts` | `TabBarHandle` 新增 `getNextSession(currentName)` |
| `src/web/desktop/desktop-view.ts` | 快捷键处理增加 `Ctrl/Cmd+Tab` 分支 |
| `tests/e2e/desktop.e2e.ts` | 新增 E2E 测试：Ctrl+Tab 循环切换 tab |

## §5 测试计划

- `npx playwright test tests/e2e/desktop.e2e.ts` 验证新增用例与既有桌面 tab-bar 用例。
- `bun run build` 确保构建无类型错误。

## §6 非目标

- 不支持 `Ctrl/Cmd+Shift+Tab` 反向切换（本次只加正向循环）。
- 不在 tab UI 上增加 `⌘⇥` 之类 shortcut hint（避免与系统 app switcher 视觉混淆）。
- 移动端不新增此快捷键（移动端无 tab bar 常驻，已有 picker）。
