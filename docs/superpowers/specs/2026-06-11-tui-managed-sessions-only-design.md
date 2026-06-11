# feat(server): hub TUI 只列 tmux-hub 管理的 session，与 WEB 一致

> 日期：2026-06-11
> 类型：功能（行为对齐）

## §1 第一性原理：要什么

hub TUI（`tmux-hub tui`，ssh / Termius 连进的菜单）列出的 session，应该只是
**被 tmux-hub 管理的那部分**（通过 template 启动、或经 `tmux-hub launch` / `POST /sessions`
创建的 ad-hoc），而**不是本机所有裸 tmux session**。这样 TUI 与 WEB 看到的 session 集合
一致——用户在两个入口看到同一份「hub 托管列表」，不会被无关的私有 tmux session 污染。

核心约束：判定「是否被管理」的逻辑必须**和 WEB 同源**，不能各写一套漂移。

## §2 现状与根因

- **WEB**：`SessionRegistry.poll()` 用 `all.filter(s => managed.has(s.name))` 把
  `tmux list-sessions` 的全集过滤成「在 managed-db 里登记过」的子集；`registry.snapshot()`
  即 managed-only，WEB 经 `/events` snapshot 消费。
- **TUI**：`bin/tmux-hub` 的 `handleTui` 直接调本地 `listSessions()`（裸
  `tmux list-sessions`），**没有 managed 过滤** → 列出所有 tmux session。

两条路径对「session 集合」的定义不一致，就是本次要消除的差异。

`managed-db`（`~/.cache/tmux-hub/managed-sessions.db`，或 `TMUX_HUB_DB_PATH`）是
「哪些 session 被管理」的 SSoT：`POST /templates/:id/run` 和 `POST /sessions` 落库，
registry 轮询时反向 prune 掉已死的条目。

## §3 方案设计

让 TUI 复用 **WEB 同一个过滤谓词**，并就地读 managed-db（server-less，保持 TUI 现有
「不依赖 hub HTTP server 也能列 session」的架构）。

```
listSessions()  ──► all: SessionInfo[]      (裸 tmux 全集)
readManagedNames(TMUX_HUB_DB_PATH) ──► managed: Set<string>   (直接读 SQLite)
        │
        ▼
filterManagedSessions(all, managed)  ◄── 与 registry.poll() 共用的同一个纯函数
        │
        ▼
   sessions  ──► buildMenu / --list / --select ...
```

**同源保证**：把 registry 里内联的过滤抽成 `filterManagedSessions(all, managed)` 纯函数，
`SessionRegistry.poll()` 和 TUI 都调它——逻辑只有一份。CLI 读库与 registry 读库结果对
「可见集合」等价：CLI 用 live `listSessions()` 取交集，已死的 managed 条目自然不出现（与
registry prune 后的 `next` 等价），CLI 只读不写（prune 这种写副作用仍归 server）。

**数据源选择**（已与用户确认）：CLI 直接读 managed-db，而非新增 `GET /sessions` 走 server。
理由：保持 TUI server-less 读取架构；hub HTTP server 挂了也能正确列管理集；过滤结果与 WEB 同源等价。

**server-less 读**：新增 `readManagedNames(dbPath?)`——只读打开、不建表、不打日志（区别于
`ManagedSessionDb` 构造器会 mkdir + CREATE TABLE + `logger.info`，那些副作用不该出现在
用户态 CLI 输出里）。db 文件 / 表不存在时返回空集（语义：当前没有任何被管理的 session）。

## §4 改动清单

| 文件 | 改动要点 |
|------|----------|
| `src/server/session-registry.ts` | 抽出 `export function filterManagedSessions(all, managed)`；`poll()` 改用它 |
| `src/server/managed-db.ts` | 新增 `export function readManagedNames(dbPath?): Set<string>`——quiet / 只读 / 文件或表缺失返回空集 |
| `bin/tmux-hub` | `handleTui` 在 `listSessions()` 后用 `filterManagedSessions(all, readManagedNames())` 过滤；其余（buildMenu/--list/--select/--select-template）沿用过滤后的 `sessions` |
| `tests/unit/session-registry.test.ts` | `filterManagedSessions` 纯函数用例（含交集/空 managed/已死条目） |
| `tests/unit/managed-db.test.ts` | `readManagedNames` 用例（temp db：登记可见、未登记不可见、文件缺失返回空） |
| `tests/integration/hub-tui.test.ts` | harness 经 `TMUX_HUB_DB_PATH` 指向 temp db，把要可见的测试 session 登记进去；新增「未登记的裸 tmux session 不出现在 --list」回归用例 |

## §5 测试计划

- **Unit**：
  - `filterManagedSessions`：managed 子集过滤、空 managed → 空、managed 含已死名 → 不出现。
  - `readManagedNames`：登记的 name 命中、未登记的不命中、db 文件不存在 → 空集。
- **Integration**（`tests/integration/hub-tui.test.ts`）：
  - harness 设 `TMUX_HUB_DB_PATH`，对要可见的 session 调 `addManaged()` 登记。
  - 既有 `--list`/`--select` 用例改为：创建 session 后登记，断言可见（行为不变）。
  - **新增**：创建一个**不登记**的裸 tmux session → `--list` 中**不出现** + `--select` 它 → not found。
- **手动验收**：本机存在若干私有 tmux session + 若干 hub 托管 session，ssh 进 TUI 只看到托管那批，与 WEB 对齐。

## §6 非目标

- 不改 WEB 路径行为（仅抽函数复用，结果等价）。
- 不在 CLI 侧做 managed-db 的 prune 写操作（仍由 server registry 负责）。
- 不新增 `GET /sessions` HTTP 端点（本次走 server-less 直读）。
