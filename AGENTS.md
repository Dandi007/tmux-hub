# AGENTS.md — tmux-hub

本文件是 AI agent（Claude Code / OpenCode / Codex 等）在本仓库工作时的行为契约入口。
人类开发者也应遵守同等标准。**本文件只做导航**；纪律正文见 `docs/constitution/`。

## 1  仓库概览

| 维度 | 值 |
|------|-----|
| 运行时 | Bun (server) + Vite (web build) |
| 框架 | Hono (HTTP/WS) · xterm.js (terminal) · vite-plugin-pwa |
| 测试 | bun:test (unit/integration) · Playwright (E2E) |
| 部署 | `deploy/tmux-hub.zsh` wrapper → `bun run start` |
| 分支策略 | `main` 为主干，feature 在 `feat/*` 或 `fix/*` 分支开发 |

源码布局（`src/server` · `src/shared` · `src/web/{desktop,mobile,pwa,shared,ui,upload}`）与产品目标见 [README.md](README.md) 与 [docs/specs/001-architecture.md](docs/specs/001-architecture.md)。

## 2  开发流程 · 3  测试规范 · 4  代码约定

**正文已整体移入 [docs/constitution/001-development-discipline.md](docs/constitution/001-development-discipline.md)，章节编号不变、一字未改。**

- **§2.1 每个 MR 必须携带 spec** —— 写代码前先在 `docs/superpowers/specs/` 建 `YYYY-MM-DD-<feature-slug>-design.md`。见 [constitution §2.1](docs/constitution/001-development-discipline.md)。
- §2.2 分支与提交 · §2.3 MR 结构 · §3 测试规范（三层金字塔 / E2E 测行为不测实现 / checklist）· §4 代码约定（文件组织 / CSS / 协议与类型 / 错误处理）—— 同上。

## 文档地图

`docs/specs/` 与 `docs/constitution/` 命名 `NNN-kebab-topic.md`，三位递增、号码不复用、两目录独立编号。

- [docs/specs/001-architecture.md](docs/specs/001-architecture.md) —— 架构文档
- [docs/constitution/001-development-discipline.md](docs/constitution/001-development-discipline.md) —— §2 开发流程 / §3 测试规范 / §4 代码约定 / §5 分支与合入 / §6 文档
- [`docs/superpowers/specs/`](docs/superpowers/specs/) 与 [`docs/superpowers/plans/`](docs/superpowers/plans/) —— **每-MR 设计文档与实施计划的现行落点**（§2.1 强制、PR 模板勾选项引用）。**不适用 `NNN-` 命名，保持 `YYYY-MM-DD-<slug>` 原样。**
- [CLAUDE.md](CLAUDE.md) —— Claude Code 专用补充：双平台部署拓扑、重启安全规则、发布流程。

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

## 6  开发纪律速览

- 改动一律走 PR；`main` 只经人工审核代合，禁止直接 push。
- **dev-dispatch 单的 base 禁止是 `main`**（生态宪法第十条）。
- 不在主 checkout 上开分支干活（macOS `~/code/tmux-hub` / NUC `/data/code/self/tmux-hub` 都算）。
- 本仓无 release 分支；发布见 [CLAUDE.md](CLAUDE.md) 的双平台拓扑。
- **每个 MR 必须携带 spec**（§2.1）；E2E 测行为不测实现（§3.2）。
- 文档移动必须 `git mv` 保历史；新增文档同步登记进上面的文档地图。
