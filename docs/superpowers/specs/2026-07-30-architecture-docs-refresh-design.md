# 2026-07-30 架构文档刷新（docs-only）

## §1 第一性原理：要什么

README 是仓库唯一的介绍性文档，但其「技术实现」段落停留在早期形态：未覆盖语音输入、命令建议（suggest）、agent 状态识别、desktop 标签快捷键、emulator 快照回放、registry 去抖防误删、三层认证、滚动恢复体系等已落地的核心机制。要什么：

1. 一份**当前态**的架构文档 `docs/architecture.md`——模块地图、数据流、协议、配置全集、测试隔离，面向要读懂 / 修改代码的人；
2. README（介绍文档）与代码现状对齐，保持速览定位，深挖链接到架构文档。

## §2 现状与根因

- README「核心功能」表缺 voice / suggest / cc-status / TUI / 桌面快捷键；「关键机制」缺 emulator 快照、registry 去抖（#90/#92）、滚动真值收敛（#87/#88/#91/#93）、gate-id 认证层与 SQLite 持久化。
- 仓库没有独立架构文档；设计知识散落在 16 份 per-MR spec 中，无当前态汇总。

## §3 方案设计

- 新增 `docs/architecture.md`：总览图（mermaid）→ 目录结构 → 输出 / 输入 / session 生命周期 / 认证 / 前端（终端、滚动、视图、PWA）/ 语音 / suggest / TUI / 配置 / 测试隔离，共 12 节。内容基于对 `src/server`、`src/web`、`src/shared` 全量源码的深读，不引入代码变更。
- README 只动「核心功能」表、「架构总览 + 关键机制 + 技术栈」段与文末链接，其余（部署、`POST /sessions`、TUI 用法）经核对与代码一致，不动。

## §4 改动清单

| 文件 | 改动 |
|------|------|
| `docs/architecture.md` | 新增 |
| `README.md` | 功能表扩充、架构速览与关键机制更新、指向架构文档 |
| 本 spec | 新增 |

## §5 测试计划

docs-only，无行为变更；`bun test` 照常跑通即可。

## §6 非目标

- 不改任何代码 / 配置；不回填历史 spec；不重写 AGENTS.md / CLAUDE.md。
