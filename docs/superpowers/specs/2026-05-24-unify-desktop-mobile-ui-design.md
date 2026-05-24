# Unify Desktop & Mobile UI

## §1 第一性原理：要什么

桌面端和移动端应共享同一套布局结构。用户不应因为切换设备而面对完全不同的界面范式。

目标布局（两端共用）：
```
┌──────────────────────────┐
│  [☰]  Session Picker  ▾  │  ← 顶部：session 下拉选择器 + sidebar 切换
├──────────────────────────┤
│                          │
│       Terminal / TUI     │  ← 中间：终端区占满
│                          │
├──────────────────────────┤
│  [✎ 输入]  [📎 附件]     │  ← 底部工具栏
└──────────────────────────┘
```

桌面端与移动端的合理差异：
- 桌面端 terminal 保持 read-write（物理键盘直接输入到 xterm）
- 桌面端不需要底部虚拟键盘（Esc/Tab/方向键等）
- 桌面端保留 sidebar（session list + template drawer），但默认隐藏，通过 ☰ 按钮切换
- 桌面端保留剪贴板图片粘贴

## §2 现状与根因

### 布局结构
- **桌面端**：双列 grid 布局（左 sidebar 常驻 + 右 terminal），sidebar 包含 session-list + template-drawer
- **移动端**：单列 flex column 布局（顶部 picker → terminal → drawer → toolbar）
- 根因：两端独立开发，桌面端保持了传统 IDE 式 sidebar 范式

### Session 元信息
- **桌面端**：显示 `Xw · Yc`（windows · clients）
- **移动端**：显示相对时间（刚刚/5m/2h）
- 根因：独立开发，各选了不同维度

## §3 方案设计

### 3.1 桌面端布局重构

将 desktop-view.ts 从 sidebar+main grid 重构为 mobile-like column layout：

```
.desktop-shell (flex column, 100dvh)
├── header.desktop-shell__header
│   ├── button.desktop-shell__sidebar-toggle  ☰
│   └── session-picker (复用 mobile/session-picker.ts)
├── aside.desktop-shell__sidebar (position: fixed, 默认隐藏)
│   ├── session-list (现有)
│   └── template-drawer (现有)
├── div.desktop-shell__sidebar-backdrop (点击关闭 sidebar)
├── div.desktop-shell__term-host (flex: 1)
│   └── terminal (readOnly: false)
├── div.mobile-drawer (复用 mobile 的输入抽屉)
└── div.desktop-toolbar
    ├── button 输入切换 (✎)
    └── button 图片附件 (📎)
    （无 special-keys 网格）
```

### 3.2 Session 元信息统一

提取 `relativeTime()` 和 `formatSessionMeta()` 到 `src/shared/session-name.ts`，两端统一显示 `5m · 3w·1c`。

### 3.3 SSE 管理

桌面端 SSE 架构改为与移动端一致：desktop-view.ts 拥有主 SSE 订阅，向 picker 推送数据。sidebar 的 session-list 保留自有 SSE（独立生命周期）。

## §4 改动清单

| 文件 | 改动 |
|------|------|
| `src/shared/session-name.ts` | 新增 `relativeTime()` 和 `formatSessionMeta()` |
| `src/web/desktop/desktop-view.ts` | 重写：从 sidebar grid 改为 column + picker + toolbar 布局 |
| `src/web/mobile/session-picker.ts` | meta 改用 `formatSessionMeta()` |
| `src/web/style.css` | 重写 `.desktop-shell` 系列样式 |
| `src/web/desktop/session-list.ts` | meta 改用 `formatSessionMeta()` |

## §5 测试计划

- [ ] 桌面端显示 session picker 下拉选择器
- [ ] 桌面端 ☰ 按钮切换 sidebar 显示/隐藏
- [ ] 桌面端 terminal 可直接键盘输入（read-write）
- [ ] 桌面端底部有输入切换和附件按钮，无虚拟键盘
- [ ] 桌面端剪贴板图片粘贴仍可用
- [ ] 移动端功能无回归
- [ ] Session 元信息两端一致

## §6 非目标

- 不改变 terminal 读写模式（桌面 read-write，移动 read-only）
- 不移动文件位置（session-picker 暂留 mobile/ 目录，后续可重构到 ui/）
- 不改变移动端布局
