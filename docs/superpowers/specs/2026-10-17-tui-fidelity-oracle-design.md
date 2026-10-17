# TUI 回传保真 oracle

> RSI loop 第 3 轮自主选题（backlog P1）。loop 级目标已与用户确认；本 spec 记录 agent 自己得出的需求。

## 需求

hub 的核心承诺是：浏览器里看到的终端内容与 tmux pane 一致。现有 E2E 只对 `capture-pane` 做断言（ground truth 那一侧），从来没有检查过浏览器 xterm 实际显示了什么。`emulator-tui.e2e.ts` 也明确写着 "Pixel-level no garble … is not asserted"。所以回放、重连、resize 出现错位时，没有任何测试能发现。

需要一个可以反复运行的 oracle：在关键时刻，浏览器 xterm 的可见屏文本必须与 `tmux capture-pane -p` 逐行一致（尺寸相同、去掉行尾空白、去掉末尾空行）。

## 设计

- **probe**（`src/web/terminal.ts`）：仅在 `?debug=term` 时，在 `window.__tmuxHubTerms[session]` 上挂只读 probe：`state` / `cols` / `rows` / `screen()`（`buffer.baseY` 起的 rows 行，经 `translateToString(true)` 得到，宽字符会自动跳过占位 cell），以及 `dropSocket()`（关掉当前 WS，走真实的 `onclose → enterReconnecting` 路径）。terminal close 时注销。不带该参数时行为不变。canvas renderer 没有文本 DOM，只能这样读取。
- `src/web/shared/debug-flags.ts`：抽出 `debugEnabled(flag)`，`perfEnabled()` 改为调用它。
- **suite**（`tests/e2e/fidelity-suite.ts`）：以函数形式定义，挂在 emulator project 上（`emulator-fidelity.e2e.ts`）。prod 和 dogfood 都开着 `TMUX_HUB_EMULATOR=1`，这是真实路径。
  - 先产生输出再 attach（snapshot），attach 后流式输出 400 行，断线期间产生 50 行后重连，reload 重新 attach；每一步都与 tmux 比对。内容包含 ANSI 颜色、CJK、全角标点、box drawing。
  - 在尺寸稳定时起 vim（alt-screen），断线期间移动光标并删行，重连后比对。
  - `createSession` 抽成 `helpers.makeCreateSession`，desktop 和 emulator 两套 fixture 共用。
- legacy 字节回放路径（flag 关）不跑 oracle：实测首次 attach 只剩 prompt，因为尾部字节重放不含 attach 前的屏幕状态。它只为回滚而保留。

## oracle 已发现的 bug（以 `test.fixme` 形式入库，并写进 backlog）

1. **resize 后错位**（约 1/6）：浏览器缩小后再输出，xterm 多出 zsh PROMPT_SP 的 `%` 行，之后整屏错一行，不会自愈。
2. **attach 引发的 resize 让运行中的 TUI 错位**（vim 约 1/25；刚起的 zsh 更高，prompt 会叠画多次）：attach 时 pane 从 200x50 钉到浏览器尺寸，应用重绘后 xterm 与 tmux 分叉，不会自愈。

共同的根因假设：attach 和 resize 时，snapshot 来自 `capture-pane`，而实时字节来自 pipe-pane 文件轮询，两者没有按字节 offset 对齐。`attachWithReplay` 注释里假设重叠是 "self-correcting"，但对相对光标移动（zsh / vim 重绘）不成立。修复另开 PR，修好后去掉对应的 fixme。

## 验收

- emulator project 下 `emulator-fidelity.e2e.ts` 运行 `--repeat-each=20`：40/40 passed（2 个 fixme 跳过）。
- 全量 unit/integration 与 E2E（desktop + emulator）回归通过。
- dogfood 上用 `?debug=term` 打开会话，probe 的屏幕文本与 `tmux -L hub-dogfood capture-pane -p` 一致。

## 部署

前端改动只在 `?debug=term` 下生效。合入后部署 dogfood，并按上一条做验收。
