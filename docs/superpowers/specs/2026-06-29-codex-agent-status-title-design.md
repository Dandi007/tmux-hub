# Codex Agent Status Title Design

## §1 第一性原理：要什么

tmux-hub 的 session 列表需要同时支持 Claude Code 与 Codex。用户只看手机或浏览器时，应能直接看到当前 agent 的动态标题，并用 icon 判断它是在等待输入还是正在工作。

验收标准：

- Claude Code 继续按现有规则显示动态标题与状态 icon。
- Codex 的 `pane_title` 以 Braille spinner 开头时，也显示动态标题并标记为 working。
- 普通 shell / hostname title 不被误判成 agent。

## §2 现状与根因

当前状态检测集中在 `src/web/shared/cc-status.ts`，只覆盖 Claude Code 已知 spinner：`⠐⠂⠈⠠⠄⠁` 与 idle 标记 `✳`。

NUC 当前真实 tmux 状态显示 Codex session 的 `pane_title` 为：

```text
kb-codex-20260629061455|⠏ vault|node
kb-codex-20260629063724|⠧ vault|node
```

`⠏` 与 `⠧` 不在旧白名单里，因此 UI 回退显示 session name，看不到 Codex 动态标题和 working 状态。

## §3 方案设计

继续复用 `pane_title`，不新增后端协议字段。

前端把检测逻辑从 Claude Code 专用扩展为 agent status：

- `✳`：idle，显示 `💬`。
- 任意 Braille Unicode block 首字符 `U+2800..U+28FF`：working，显示 `⚡`。
- 其他 title：unknown，保持显示 session name。

旧导出 `getClaudeCodeStatus` / `isClaudeCodeTitle` / `getCCStatusIcon` 保留为兼容 wrapper，避免桌面与移动端一次性大重命名。

## §4 改动清单

| 文件 | 改动 |
|---|---|
| `src/web/shared/cc-status.ts` | 新增 agent status API，扩大 Braille spinner 覆盖，保留旧导出 |
| `tests/unit/agent-status.test.ts` | 覆盖 Claude Code idle、Claude/Codex working、普通 title 非误判 |

## §5 测试计划

- `bun test tests/unit/agent-status.test.ts`
- `bun run build`

## §6 非目标

- 不推断 Codex idle 状态，除非 Codex 明确发布稳定 idle title 标记。
- 不改后端 `SessionInfo` 协议。
- 不调整现有 emoji 语义。
