# 字符宽度对齐 tmux（Unicode 11）+ 剥离 screen 窗口名序列

- 日期：2026-10-17（RSI 第 9 轮）
- 来源：吃 dogfood 时发现。对正在工作的 rsi-tmux-hub 会话做 oracle 持续比对，含 emoji 的行持续 3~4 行不一致：多出空格、残留 `o`/`m` 字符，直到 hub 重启、重新 attach 拿到新 snapshot 才恢复。

## 需求

实时字节流渲染出的 xterm 屏幕要与 tmux 一致，不能依赖之后的 snapshot 去「修好」屏幕。

## 根因（两个，各自独立）

1. **宽字符宽度不一致**：xterm.js 5 默认使用 Unicode 6 宽度表，xterm-headless 实测 ⚡（U+26A1）、💬（U+1F4AC）宽 1 列；tmux 3.6 实测宽 2 列，Claude Code 的 Ink 也按 2 列计算。应用按绝对列号定位（CHA/CUP，Ink 的局部重绘就是这样）时，xterm 里每遇到一个 emoji，后面的内容就错开一列，不会自愈。dogfood pipe 日志原文：`xterm 把 ⚡💬 等字符算作 1 列而 tmux/Clau\x1b[87GCode…`。
2. **screen 窗口名序列被当作文字打印**：oh-my-zsh termsupport 在 TERM=tmux* 下，每条命令前都会发 `ESC k <命令名> ESC \`。tmux 把它当作窗口改名处理掉了，xterm.js 不认识，把命令名打印到了输出行上（E2E 日志：`\x1bkprintf\x1b\\⚡…`，xterm 行首显示 `pr` 残留）。

## 设计

1. web 端加载官方 addon `xterm-addon-unicode11@0.6.0`（peer `xterm ^5.0.0`），设置 `term.unicode.activeVersion = "11"`。`term.unicode` 在 xterm 5 中是 proposed API，所以需要 `allowProposedApi: true`。
2. 服务端新增 `TitleSeqFilter`（`src/server/title-seq-filter.ts`），在 `SessionBroadcaster.poll()` 里把每个 chunk 先过滤再分发（ring、emulator、订阅者）；log 文件保留原始字节。这是一个有状态的过滤器，chunk 可以在任意字节处切开。终止符为 ST 或 BEL；名字超过 1024 字节就放弃，避免吞掉后续输出；名字中遇到 ESC 加非 `\` 时结束名字，并保留这个转义序列；chunk 末尾挂起的单个 ESC 会在下一次空闲 poll 时释放。

未采用的方案：
- 在 xterm.js 注册 ESC k handler：xterm 的 parser 不把 ESC k 之后的内容当作字符串参数处理，无法吞掉命令名。
- 改 zsh 配置（关闭 termsupport）：要改用户环境，而且其他程序（screen 风格的 title 设置）也会发同样的序列。

## 验收

- E2E（emulator）新增「emoji widths match tmux when the app positions by column」：先输出 ⚡，用 CHA 跳到第 3 列写 A，再输出 💬，用 CHA 跳到第 7 列写 B。要求实时流渲染即一致，期间不能有 resync/replay snapshot 介入。修复前 3/3 红（`prA 💬fB`），只修宽度时仍红（`prA 💬B`），两个都修后 10/10。
- 单测 `title-seq-filter.test.ts`：剥离、BEL 终止、逐字节切分、其他转义和单个 ESC 透传、超长名字放弃、名字中出现其他转义。集成测试：broadcaster 的实时订阅者收不到该序列，尾部的单个 ESC 会被释放。
- 全量 unit/integration 与 E2E 全绿。

## 部署与发布

web 与服务端一起发布。旧页面要刷新后才加载 unicode11；服务端过滤立即对所有页面生效。合入后 `deploy-dogfood`，在 dogfood 上对正在工作的 CC 会话持续跑 oracle 100 秒，确认没有持续的差异行。prod 由人前移 `accepted` 后生效。
