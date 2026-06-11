# fix(server): hub TUI 启动 template 时用 template 自己的 cwd_choices，而非硬编码 `~`

> 日期：2026-06-11
> 类型：Bug 修复（follow-up of #42 hub TUI）

## §1 第一性原理：要什么

在 hub TUI（`tmux-hub tui`，ssh / Termius 连进来的终端菜单）里，用户用方向键选中一个
**template** 后按回车，期望：**按该 template 的定义新建并 attach 进 session**——和选中
一个 **session** 按回车能 attach 进去，是对称的体验。

核心约束：template 的工作目录必须是它自己声明的 `cwd_choices` 之一（server 侧 grammar
校验，不可绕过）。

## §2 现状与根因

**症状**：Termius / ssh 连进 hub TUI，回车选 **session** 能进去；回车选 **template**
进不去——回到菜单，像没反应。

**根因**：TUI 客户端（`bin/tmux-hub`）在跑 template 时把工作目录**硬编码成 `~`**：

- `executeAction()` 交互路径：`body: JSON.stringify({ cwd: "~" })`
- `--select-template` 非交互路径：同样硬编码 `{ cwd: "~" }`

而 server 的 `TemplateRunner.run()` 会校验 `cwd ∈ template.cwd_choices`，否则
返回 **400 `cwd '~' not in cwd_choices`**。真实 `templates.yaml` 里除了 `shell`
模板用 `["~"]`，其余模板（`kb-cc` / `cw` / `cc-ds` / `dd-*`）的 `cwd_choices` 都是
**绝对路径**，不含 `~`。

于是：
- 选 **session** → `attach`，无 cwd 约束 → 成功。
- 选 **绝对路径 template** → POST `{cwd:"~"}` → server 400 → 客户端 catch 后打到
  stderr 并 `return` → `--loop` 模式下直接回菜单 → 表现为「回车进不去」。

这**不是按键编码（CR/LF）问题**：回车字节一直被正确接收（session 能进就是证据），
坏的是 template 启动路径的 cwd 取值。

## §3 方案设计

让客户端在启动 template 时，使用**该 template 自己的 `cwd_choices[0]`** 作为工作目录，
而不是硬编码 `~`。`/templates` endpoint 早已返回 `cwd_choices`（见
`main.ts` `app.get("/templates")`），客户端只是之前没接住。

数据流（交互路径）：

```
GET /templates  ──► [{id,name,cwd_choices}]
        │
        ▼
   buildMenu()  ──► MenuItem{kind:"template", id, name, cwd_choices}
        │
        ▼ (fzf 选中 index)
 resolveSelection() ──► {action:"run-template", templateId, cwd: cwd_choices[0]}
        │
        ▼
  executeAction() ──► POST /templates/:id/run { cwd }   // cwd 来自 action，不再是 "~"
        │
        ▼
     doAttach(name)
```

`cwd_choices` 由 zod schema 保证 `min(1)`，故 `[0]` 必存在。

## §4 改动清单

| 文件 | 改动要点 |
|------|----------|
| `src/server/hub-tui.ts` | `TemplateSummary` / `MenuItem(template)` 增加 `cwd_choices: string[]`；`buildMenu` 透传；`SelectionAction(run-template)` 增加 `cwd`；`resolveSelection` 取 `item.cwd_choices[0]` |
| `bin/tmux-hub` | 拉取 `/templates` 的类型加上 `cwd_choices`；`executeAction` 用 `action.cwd` 取代 `"~"`；`--select-template` 路径从拉到的 templates 里查 `cwd_choices[0]`，查不到则报错退出 |
| `tests/unit/hub-tui.test.ts` | `buildMenu`/`resolveSelection` 用例补 `cwd_choices`，断言 run-template 带正确 `cwd`；新增「绝对路径 template 解析出的 cwd 不是 `~`」回归用例 |

## §5 测试计划

- **Unit**（`tests/unit/hub-tui.test.ts`）：
  - `resolveSelection` 对 template 返回 `{action:"run-template", templateId, cwd}`，
    且 `cwd === cwd_choices[0]`（用绝对路径 fixture，断言 `cwd !== "~"`）——这是本 bug 的
    直接回归。
  - `buildMenu` 产出的 template item 携带 `cwd_choices`。
- **Integration**（已有 `tests/integration/template-run.test.ts`）：`TemplateRunner`
  对「cwd 不在 choices」返回 400 的行为已覆盖——本修复正是让客户端不再触发它。
- **手动验收**：Termius 连 hub TUI，回车选 `kb-cc`（绝对路径模板）→ 成功 attach。

## §6 非目标

- **多 cwd_choices 的交互选择**：当 `cwd_choices` 有多个时，本次仍取 `[0]` 作为默认。
  真实配置中每个 template 恰好只有一个 choice，故不阻塞本 bug。多选弹二级 picker 留作
  后续增强。
- 不触碰按键/PTY 编码，不改 server 校验逻辑。
