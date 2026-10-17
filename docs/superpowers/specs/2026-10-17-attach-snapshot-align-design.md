# attach snapshot 与在途字节对齐

- 日期：2026-10-17（RSI 第 4 轮）
- 来源：backlog P0「attach/resize 时 snapshot 与字节流未对齐 → 屏幕永久错位」，第 3 轮保真 oracle 抓到

## 需求

浏览器 attach 一个**正在重绘**的会话时（典型场景：手机 attach 把 pane 钉到自身尺寸，Claude Code / vim / zsh 收到 SIGWINCH 后重绘），xterm 可见屏必须与 `tmux capture-pane` 一致，不能永久错位。

本 PR 只覆盖 **attach 时**的错位（backlog ②）。已 attach 后浏览器 resize 引起的错位（backlog ①，xterm 与 tmux 的 reflow 不一致）不在本 PR 内，fixme 保留。

## 根因

`attachWithReplay`（emulator 路径）先注册 tap，再跑 `capture-pane`，然后把 tap 收到的字节接在 snapshot 后面发出。字节链路是 tmux → pipe-pane sink → log 文件 → 5ms 轮询。capture 时 tmux **已经渲染**、但还在这条链路上的字节，既包含在 snapshot 里，又会从 tap 再发一次。旧注释假设这段重叠会「自我纠正」，但这只对绝对定位成立；CR/LF、CUU、zsh PROMPT_SP 等相对移动重放两次后，屏幕会整体偏移，而且不会自愈。

第二个根因（新增的 fresh shell 测试暴露，15/15 稳定复现）：恢复流里**没有光标位置**。写完 capture 正文后，客户端光标停在最后一行之下；回放的 DECSTBM 还会把光标归到 home。attach 之后用相对移动输出的内容（zsh 在 attach pin 触发的 SIGWINCH 后重绘 prompt）因此会落到错误的行，屏幕上出现两个 prompt。

## 设计

capture 只有在「capture 前一刻到 capture 后 `ALIGN_SETTLE_MS`（30ms）」这段时间内链路上没有新字节时才算数：

1. 同步 `poll()` 把已落盘的字节读完，清空 pending；
2. `capture-pane`；
3. 等 30ms 后再 `poll()` 一次；
4. pending 为空：snapshot 与字节流对齐，发出 snapshot；不为空：这些字节已经包含在下一次 capture 里，丢掉后重试；
5. 最多 capture `ALIGN_MAX_CAPTURES`（5）次。一直不静默的 pane（持续流式输出）退回旧行为：发最后一次 snapshot，再接上它之后的字节，宁可重叠也不丢字节。

正确性：tap 在每次 capture 前清空，所以 pending 里的字节都是在这次 capture 前不久或之后由 tmux 产生的。静默就意味着没有任何字节同时出现在 snapshot 和 tap 中。只要链路延迟（一个 5ms tick 加 sink 写入）小于 30ms，静默判断就成立。

光标：capture 成功后立即 `display-message -p '#{cursor_x} #{cursor_y}'`，在 modes 之后追加绝对 CUP。这次读取发生在上面的对齐窗口内，所以静默成立时，它与 capture 描述的是同一时刻。读取失败就不追加，与旧行为一致。

代价：静默 pane 的 attach 多 30ms；重绘中的 pane 每次重试多一个 capture 加 30ms，最多约 200ms。

未采用的方案：
- 用服务端 emulator 做 snapshot（与字节流天然同步）：会退回宽度冻结的历史 reflow 问题（这正是当初改用 capture-pane 的原因）。
- 先等静默再 capture：等价于重试循环的第一步，循环已经覆盖。

## 验收

- 新增 `tests/integration/attach-snapshot-alignment.test.ts`：在途字节不会叠加到 snapshot 上；静默 pane 只 capture 一次；永不静默的 pane 有界重试，并且不丢字节。修复前 2 个 fail。
- `tests/e2e/fidelity-suite.ts`：去掉「vim attach that resizes a running TUI」的 fixme；新增「fresh shell attach」（刚起的 zsh 在画第一个 prompt 时 attach）。整个 oracle suite `--repeat-each=10` 40/40 通过（resize 的 fixme 仍跳过）。
- 新增单测：snapshot 以 tmux 光标的 CUP 结尾（在 modes 之后）。
- 全量 unit/integration 与 E2E（desktop + emulator）全绿。

## 附带：E2E env 按 worktree 隔离

`playwright.config.ts` 与两个 fixtures 用 cwd 的 base64 前 12 个字符作 hash，而 `/data/code/` 下所有路径的这一段都是 `L2RhdGEvY29k`。结果所有 worktree 共用一个 E2E env 文件和 tmux server，会话不断累积（实测 268 个）。每次页面加载都会给每个会话开一个 ws，attach 测试因此超时。改为对完整 cwd 做 sha256 后截取前 12 位。

## 部署与发布

只改服务端 `output-broadcaster.ts`，没有协议或配置变更。合入后 `deploy-dogfood`，在 dogfood 上对当前会话 attach 跑 oracle，确认 diffRows=0。prod 由人前移 `accepted` 后生效。
