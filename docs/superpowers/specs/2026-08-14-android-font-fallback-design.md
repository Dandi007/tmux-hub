# Android 字体兜底：终端 tofu / 溢出压字修复 + kill 按钮图标去字体化

日期：2026-08-14
分支：`fix/android-font-fallback`

## §1 第一性原理：要什么

在 Android 浏览器上打开 tmux-hub，终端内容与 UI 图标应当**渲染完整、不溢出、不出现空心方框（tofu）**，且修复**不得改变 Apple 平台（iOS / macOS）现有的渲染效果**——那里一切正常。

实测症状（Android Chrome，2026-08-14 真机截图）：

1. Claude Code 状态行的 `⏵⏵ bypass permissions` 渲染为 `口口`（U+23F5 无 glyph → tofu）。
2. 终端文本里的 `→`（U+2192）由系统 CJK fallback 字体提供**全宽 glyph**，被画进 xterm 分配的 1 cell 槽位后溢出，划穿相邻字符（观感像 strikethrough）。
3. 顶栏 kill 按钮的 `⏻`（U+23FB）同样 tofu，红底上一个空心方框。

## §2 现状与根因

- `src/web/terminal.ts` 的 xterm `fontFamily: "ui-monospace, Menlo, monospace"` 与 `src/web/style.css` 的 `--font-mono: ui-monospace, SFMono-Regular, Menlo, monospace` 都是纯 Apple 字体栈。Android 上前两级全部 miss，落到裸 `monospace`（Roboto Mono）：
  - Roboto Mono 符号覆盖窄，`⏵` `⏻` 无 glyph → tofu；
  - `→` 等 East Asian Ambiguous 字符由 Noto Sans CJK 兜底，给出的是**全宽字形**，而 tmux/xterm 按窄宽（1 cell）计宽 → canvas 渲染不裁剪，溢出压字。
- 仓库没有打包任何 webfont，符号渲染完全听凭平台字体。
- kill 按钮用文本字符 `⏻` 当图标（`session-picker.ts`），图标可用性绑死平台字体覆盖。

## §3 方案设计

### 字体链（per-glyph fallback）

```
终端:  ui-monospace → Menlo → "Iosevka Term"(webfont) → monospace
UI:    ui-monospace → SFMono-Regular → Menlo → "Iosevka Term"(webfont) → monospace
```

CSS 字体匹配是**逐 glyph** 走 fallback 链的：

- **Apple 平台**：`ui-monospace`（SF Mono）/ Menlo 命中在前，拉丁文本渲染**零变化**；只有 SF Mono 本身缺的字符（如 `⏵`）改由 Iosevka Term 提供——之前靠系统 Apple Symbols 兜底，现在换成严格 1-cell 宽的 glyph，只会更贴合终端网格。
- **Android**：前两级 miss，Iosevka Term 成为终端主字体（拉丁从 Roboto Mono 换为 Iosevka，中性偏改善）；`⏵` `→` `█` `░` 等全部由它提供，**每个 glyph advance 恰为 0.5em = 1 cell**（已用 fontTools 逐字验证），tofu 与溢出同根消除。
- **CJK**：子集不含 CJK，继续落到平台 CJK 字体按双宽渲染，行为不变。

### 为什么是 Iosevka Term（而非 fontsource 上的现成包）

- fontsource 无 iosevka-term / hack 包；`@fontsource/iosevka`（默认变体）的箭头/媒体键是 1.0em 全宽，塞 1 cell 会复现溢出问题——**Term 变体存在的意义就是把这类符号做成窄版**。
- JetBrains Mono + Noto Sans Symbols 2 组合缺 `→`（两者都没有），无法闭环。

### 交付形态

- 从官方 release（be5invis/Iosevka v34.8.0）取 IosevkaTerm Regular/Bold TTF，`pyftsubset` 裁到终端相关 Unicode 区段（ASCII、Latin-1/Ext-A、通用标点、箭头、数学运算符、Misc Technical、box drawing、block elements、geometric shapes、misc symbols、dingbats、arrows-B、Powerline PUA），woff2 产物各 ~47KB，**直接入库**（OFL 1.1 允许再分发，license 全文随附）。
- 再生成脚本 `scripts/subset-iosevka-term.sh` 入库，锁定裁剪参数。

### 加载时序（canvas atlas 陷阱）

xterm CanvasAddon 首次绘制即把 glyph 烤进 texture atlas，字体后到不会自动重绘。两道防线：

1. `attachTerminal()` 开头 `await ensureTerminalFonts()`（`document.fonts.load` + 2s 超时兜底，不阻塞弱网/断网场景）；
2. `document.fonts.ready` 后调用 `term.clearTextureAtlas()`，覆盖超时路径。

### kill 按钮

`⏻` 文本字符换 inline SVG（`stroke="currentColor"`，继承按钮配色），图标彻底脱离平台字体覆盖。

## §4 改动清单

| 文件 | 改动 |
|------|------|
| `src/web/fonts/iosevka-term-{regular,bold}.woff2` | 新增：裁剪后的 webfont 产物（各 ~47KB） |
| `src/web/fonts/fonts.css` | 新增：两条 `@font-face`（400/700，`font-display: swap`） |
| `src/web/fonts/LICENSE.md` | 新增：Iosevka OFL 1.1 license 全文 |
| `scripts/subset-iosevka-term.sh` | 新增：woff2 再生成脚本（版本与裁剪参数的 SSoT） |
| `src/web/shared/fonts.ts` | 新增：`TERMINAL_FONT_FAMILY` 常量 + `ensureTerminalFonts()` 预加载 |
| `src/web/terminal.ts` | `fontFamily` 改用常量；attach 前 await 字体；`fonts.ready` → `clearTextureAtlas()` |
| `src/web/main.ts` | import `fonts/fonts.css` |
| `src/web/style.css` | `--font-mono` 插入 `"Iosevka Term"`；`.header-action > svg` 对齐规则 |
| `src/web/mobile/session-picker.ts` | kill 按钮 `⏻` → inline SVG |

## §5 测试计划

- **构建**：`bun run build` 通过，woff2 进产物且 css 引用 hash 路径正确。
- **单元/集成**：现有 `bun test` 全绿（本改动不触服务端与协议）。
- **E2E**：现有 Playwright 套件全绿；kill 按钮断言若有引用 `⏻` 文本需适配为 svg 存在性断言。
- **真机验证（dogfood）**：deploy-dogfood 后 Android Chrome 打开，确认 ① `⏵⏵` 正常渲染 ② `→` 不再划穿相邻字符 ③ kill 按钮显示电源图标；iOS Safari 对照确认外观无回归。

## §6 非目标

- 不改 Claude Code / claude-hud 状态行在窄终端下的截断行为（那是 statusline 侧的宽度自适应问题，另行处理）。
- 不给 CJK 打包 webfont（体积不划算，系统 Noto CJK 表现正确）。
- 不动 emoji 渲染（`⚖` `✏` 等走系统 color emoji，本来就正常）。
- 不切换 xterm 渲染器、不引入 Unicode 宽度选项调整。
