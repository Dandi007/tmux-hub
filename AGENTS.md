# AGENTS.md — tmux-hub

本文件是 AI agent（Claude Code / OpenCode / Codex 等）在本仓库工作时的行为契约。
人类开发者也应遵守同等标准。

---

## 1  仓库概览

| 维度 | 值 |
|------|-----|
| 运行时 | Bun (server) + Vite (web build) |
| 框架 | Hono (HTTP/WS) · xterm.js (terminal) · vite-plugin-pwa |
| 测试 | bun:test (unit/integration) · Playwright (E2E) |
| 部署 | `deploy/tmux-hub.zsh` wrapper → `bun run start` |
| 分支策略 | `main` 为主干，feature 在 `feat/*` 或 `fix/*` 分支开发 |

```
src/
├── server/          # Hono HTTP + WebSocket 服务端
├── shared/          # 前后端共享类型 (protocol.ts, session-name.ts, key-map.ts)
└── web/
    ├── desktop/     # 桌面 UI（sidebar + terminal）
    ├── mobile/      # 移动 UI（session picker + drawer + toolbar）
    ├── pwa/         # SW 注册、install prompt、shortcuts
    ├── shared/      # 前端共享控制器 (rename, kill)
    ├── ui/          # 通用组件 (toast, confirm-modal, connection-status)
    └── upload/      # 图片上传
```

---

## 2  开发流程

### 2.1  每个 MR 必须携带 spec

**在写任何代码之前**，先在 `docs/superpowers/specs/` 创建设计文档：

```
docs/superpowers/specs/YYYY-MM-DD-<feature-slug>-design.md
```

spec 必须包含：

| 章节 | 内容 | 要求 |
|------|------|------|
| **§1 第一性原理：要什么** | 从用户视角描述期望行为和核心约束 | 必须。先说「要什么」，再说技术 |
| **§2 现状与根因** | 当前代码做了什么、缺什么、为什么要改 | 改动类 MR 必须；新增可省略 |
| **§3 方案设计** | 架构图（ASCII 或 mermaid）、数据流、API 变更、状态机 | 必须 |
| **§4 改动清单** | 每个要动的文件 + 改动要点 | 必须 |
| **§5 测试计划** | 需要哪些 E2E / integration / unit 测试覆盖哪些行为 | 必须；见 §3 测试规范 |
| **§6 非目标** | 明确声明本次不做什么 | 推荐 |

> **参考格式**：`docs/superpowers/specs/2026-05-23-ws-heartbeat-reconnect-design.md`

### 2.2  分支与提交

- 从 `main` 切 `feat/<slug>` 或 `fix/<slug>` 分支
- worktree 优先创建在 `$AGENT_CODE_ROOT/worktrees/tmux-hub/<branch-slug>/`
- 提交信息遵循 conventional commits：

  ```
  <type>(<scope>): <description>
  ```

  | type | 用途 |
  |------|------|
  | `feat` | 新功能 |
  | `fix` | Bug 修复 |
  | `refactor` | 不改行为的重构 |
  | `test` | 仅测试 |
  | `docs` | 仅文档 |
  | `chore` | 构建/配置/依赖 |
  | `perf` | 性能优化 |

  scope 可选，常用：`mobile`, `desktop`, `server`, `pwa`, `terminal`, `ui`, `protocol`, `e2e`

- **原子提交**：一个 commit 聚焦一件事。功能代码和测试代码可以分开 commit。
- MR 标题格式与 commit 一致，例如 `feat(mobile): kill-session button in header`

### 2.3  MR 结构

```markdown
## Summary
- 功能要点（bullet list，3 条以内）

## Spec
- [链接到 docs/superpowers/specs/YYYY-MM-DD-xxx-design.md](docs/superpowers/specs/...)

## Changed Files
| 文件 | 说明 |
|------|------|
| `src/web/mobile/foo.ts` | 新增 xxx |

## Test Plan
- [ ] E2E: 场景描述
- [ ] Unit: 函数名或行为
```

---

## 3  测试规范

### 3.1  三层测试金字塔

| 层 | 工具 | 位置 | 关注点 | 运行 |
|----|------|------|--------|------|
| **Unit** | bun:test | `tests/unit/*.test.ts` | 纯函数、数据转换、协议校验 | `bun test tests/unit` |
| **Integration** | bun:test + real tmux | `tests/integration/*.test.ts` | server route、tmux 交互、broadcaster | `bun test tests/integration` |
| **E2E** | Playwright | `tests/e2e/*.e2e.ts` | 用户可感知的行为（feature） | `bun run test:e2e` |

### 3.2  E2E 测试：测行为，不测实现

E2E 测试验证的是**用户可感知的行为（feature）**，不是内部实现细节。

#### 什么是好的 E2E 测试

```typescript
// GOOD: 测试一个完整的用户行为
test("kill button confirm destroys session and switches to next", async ({ page, ctx }) => {
  // Arrange: 建立前置状态
  const keep = uniqSession("keep");
  const kill = uniqSession("kill");
  ctx.tmuxE2E(["new-session", "-d", "-s", keep, "sh"]);
  ctx.tmuxE2E(["new-session", "-d", "-s", kill, "sleep 60"]);

  // Act: 模拟用户操作
  // ... 导航、选择 session、点击 kill、确认

  // Assert: 验证用户可感知的结果
  // - 被 kill 的 session 从列表消失
  // - 自动切到下一个 session
  // - tmux 侧确认 session 已销毁
});
```

```typescript
// BAD: 测试内部实现
test("killSession sends POST with X-Hub-Confirm header", ...);
test("onKill callback is wired to picker", ...);
```

#### E2E 测试命名规范

测试名描述**行为**，不描述实现：

```
GOOD:
  "kill button confirm destroys session and switches to next"
  "session created externally appears in picker via SSE"
  "rename inline edit cancels on Escape"

BAD:
  "POST /sessions/:name/kill returns 200"
  "confirmModal resolves true on click"
  "SSE handler updates sessions array"
```

#### E2E 四大类行为

每个 feature 应覆盖以下维度：

| 类别 | 说明 | 示例 |
|------|------|------|
| **Golden Path** | 正常使用流程 | 点 kill → 确认 → session 消失 |
| **Cancel/Undo** | 用户中途取消 | 点 kill → 取消 → session 仍在 |
| **SSE 实时反馈** | 服务端事件驱动 UI 更新 | 外部 tmux kill → picker 自动移除 |
| **跨组件联动** | 操作影响其他 UI 部分 | kill 当前 session → 自动切到下一个 |

#### E2E 环境隔离规则

- 每次运行使用独立的 tmux socket（`hub-e2e-{pid}-{ts}`），不触碰系统默认 tmux
- 每个 test 用 `uniqSession()` 生成唯一 session 名
- test 结束时 kill 所有创建的 session
- E2E 端口 3201，与开发端口 3101 分离
- **禁止在 E2E 测试中依赖已有的 tmux session 或文件**

#### E2E Profile 分工

| Profile | 视口 | 匹配文件 | 测试范围 |
|---------|------|----------|----------|
| `desktop` | 1440x900 Chrome | `desktop.e2e.ts`, `key-conformance.e2e.ts` | sidebar、session header 按钮、xterm 键盘输入 |
| `mobile` | iPhone 14 | `mobile.e2e.ts` | session picker、drawer、toolbar 特殊键、quick-launch |
| `pwa` | 1440x900 Chrome | `pwa.e2e.ts` | manifest、SW、icon、auth gate |

### 3.3  新 feature 的测试 checklist

每个新 feature 的 MR 必须包含 E2E 测试。检查清单：

- [ ] Golden path 测试通过
- [ ] Cancel/undo 路径（如果 UI 有取消操作）
- [ ] SSE 实时更新（如果涉及 session 增删改）
- [ ] 跨组件联动（如果操作影响其他 UI 区域）
- [ ] Desktop 和 Mobile 都有覆盖（如果 feature 跨平台）
- [ ] `bun run test:e2e` 全量通过

### 3.4  Unit / Integration 测试时机

| 场景 | 测试层 |
|------|--------|
| 新增 `src/shared/` 类型/函数 | Unit |
| 新增/修改 server route | Integration |
| 新增 UI 组件交互 | E2E |
| 纯逻辑函数（ring buffer、diff 算法） | Unit |
| tmux 命令封装 | Integration |
| 前端控制器（rename-controller, kill-controller） | E2E（通过行为验证） |

---

## 4  代码约定

### 4.1  文件组织

- **前端控制器**（封装 API 调用的薄函数）放 `src/web/shared/`，命名 `*-controller.ts`
- **UI 组件**放 `src/web/ui/`
- **Mobile-only** 放 `src/web/mobile/`，**Desktop-only** 放 `src/web/desktop/`
- 新增文件不超过 400 行；超过时按职责拆分

### 4.2  CSS

- 全部在 `src/web/style.css`，BEM 命名 + CSS custom properties
- 触摸设备按钮最小尺寸 `var(--tap-min)` (44px)
- 危险操作用 `var(--color-danger)`
- 新增组件样式紧跟同类组件的 CSS 块后

### 4.3  协议与类型

- 前后端共享类型定义在 `src/shared/protocol.ts`
- Session name 校验统一用 `src/shared/session-name.ts` 的 `isGrammarOk()`
- 新增 API 路由在 `src/server/session-control.ts`（session 操作）或 `src/server/main.ts`（系统级）

### 4.4  错误处理

- 服务端 API 失败 → 返回 `{ error: string }` + 合适的 HTTP status
- 前端 API 失败 → `showToast(message, "error")`
- 危险操作（kill session）→ 必须经过 `confirmModal({ danger: true })`
- 确认 header（`X-Hub-Confirm: kill`）防止意外调用

---

## 5  运行命令速查

```bash
# 开发
bun install
bun run dev                           # hot-reload server on :3101

# 构建
bun run build                         # vite build -> dist/web/

# 测试
bun test                              # unit + integration
bun run test:e2e                      # playwright (all 4 profiles)
npx playwright test tests/e2e/mobile.e2e.ts  # 只跑 mobile

# Lint
bun run lint:tests                    # 检查测试未使用默认 tmux socket
```
