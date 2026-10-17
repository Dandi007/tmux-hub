# resize 后重发对齐 snapshot（resync）

- 日期：2026-10-17（RSI 第 5 轮）
- 来源：backlog P0「resize 后屏幕错位」，第 3 轮保真 oracle 抓到；attach 部分已在第 4 轮修好（#117）

## 需求

已 attach 的浏览器改变尺寸后（桌面拖窗口、手机转屏、软键盘弹出），xterm 屏幕必须最终与 `tmux capture-pane` 一致，后续输出也不能错位。用户向上翻看历史时，resize 不能把视口冲回底部或顶部。

## 根因

resize 时，浏览器的 xterm 和 tmux 各自对已有屏幕做 reflow，两者对软换行行的处理不一致。实测 resize 刚结束时两边文本相同，但光标行已经分叉（文本比对看不出来）。随后 app 收到 SIGWINCH 用相对移动重绘，或者继续输出，xterm 就整体错一行，不会自愈。基线：E2E resize 用例 `--repeat-each=20` 失败 2 次，都在「output after resize」。

xterm 与 tmux 的 reflow 算法无法逐一对齐，所以不去修 reflow，而是在 resize 稳定后用 tmux 的权威状态重新同步。

附带根因（开发中由 fresh-shell 用例暴露，用 ws 帧时间线定位）：**snapshot 的行布局不可靠**。旧做法是一次 capture 取「history + 可见区」，原样写入。tmux runner（`tmux-cmd.ts`）会对 stdout 做 `trimEnd()`，于是可见区末尾的空行被裁掉。只要可见区没满（新开的 shell、清屏之后），写入时就不会发生滚动，history 行直接画在了可见屏上：zsh 的 PROMPT_SP 空格行和旧 prompt 叠在当前 prompt 上面。反过来，未经裁剪的满屏输出又会因为末尾的换行多滚一行。attach 时这个问题被掩盖了：attach pin 触发的 zsh 重绘正好覆盖了这些行。resync 之后没有后续重绘，fresh-shell 用例因此 4~8 成失败。

修法：history 与可见区分开 capture、分开放置。
1. 先 `display-message` 读 `cursor_x cursor_y history_size pane_height`；
2. 若有 history，用 `capture-pane -S -<min(history_size, 上限)> -E -1` 取出写入，再补 `pane_height-1` 个 LF，确保全部进入 scrollback；
3. 光标回 home，写入可见区（单独 capture，不带 `-S`）；
4. 写入 modes，最后加 CUP。
geometry 读取在对齐窗口内完成。真实 tmux + xterm-headless 回归测试覆盖三种情况：可见区未满且有 history、满屏且有 history、没有 history；逐行比对可见屏，并检查光标、`baseY == history_size` 和 scrollback 末行。

## 设计

**服务端**
- `ResyncScheduler`（`src/server/resize-resync.ts`）：每个 ws 一个，在 web resize 被实际应用时调用 `resized(cols, rows)`。它把一串 resize debounce 成最后一次（200ms）。自上次 snapshot 以来 pane 没变过尺寸就不做事；变过就做，即使最终又回到原尺寸也做，因为 app 已经在中间尺寸下重绘过，等首次 attach 完成后才开始，同一连接上的 resync 串行执行；ws 关闭时 `dispose()`。
- `SessionBroadcaster.resync(send, cols, rows, announce)`：先把订阅者从实时流中摘下，调用 `announce()`，再复用 `attachWithReplay`（第 4 轮的对齐 capture：静默窗口 + 光标 CUP）。订阅者已经离开时不做事；legacy 字节回放路径（emulator 关）也不做事，因为回放宽度冻结的日志比漂移更糟。
- main.ts 中，announce 发送 `{"kind":"resync"}`，resync 完成后照常发送 `scrollpos` 作为 replay-done 信号。如果 resync 期间 ws 已关闭，就再退订一次，因为 resync 会重新订阅。
- **按需开启**：只有 ws URL 带 `resync=1` 的 client 才会收到。已经打开的旧页面不认识这条消息，会把 JSON 原样写进终端。

**客户端**（`src/web/terminal.ts`）
- ws URL 加上 `resync=1`。
- 收到 `resync` 后的处理与断线时相同：提取 `saveLocalLfbForReplay()`（从 `enterReconnecting` 抽出），快照本地 lfb（INV-1）并关闭上报（INV-4），清空 local-echo predictions。随后到达的 scrollpos 走 reconnect 分支（`isFirstDelivery=false`）：原来在底部的回到底部，原来向上翻的恢复到原来的行数。
- `?debug=term` probe 新增 `linesFromBottom`、`resyncs`、`scrollLines`、`visible`，供 E2E 使用。
- 隐藏的 pool slot（desktop 非激活 tab）沿用已有的 INV-5 逻辑：恢复决策挂起，等 activate 时再执行。

代价：每次 resize 稳定后多一次 capture-pane（含 scrollback）和一次客户端全量重绘。debounce 后，拖窗口的整个过程只触发一次。desktop pool 里所有 tab 常驻 attach，窗口 resize 时每个 tab 都会各自 resync 一次，N 个 tab 就是 N 次 capture。这与重连时的开销相同，可以接受。

已知限制：从收到 `resync` 到 scrollpos 恢复执行这几百毫秒内，用户的滚动会被恢复动作覆盖，因为恢复用的是收到 `resync` 时的快照。reconnect 有同样的窗口。attach 后布局稳定时可能还会发一次 resize，引起一次初始 resync，E2E 因此先等 resync 次数稳定再滚动。

未采用的方案：
- 修 xterm/tmux 的 reflow 差异：两套实现，无法保证一致。
- 只追加 CUP、不重发整屏：reflow 后的文本在实践中一致，但没有保证；整屏 snapshot 更稳。
- 由客户端在 resize 后主动请求 snapshot：时机由服务端掌握更准（resize-window 完成之后），也更容易串行化。

## 验收

- 集成 `tests/integration/snapshot-screen-fidelity.test.ts`（真实 tmux + xterm-headless）：三种屏幕布局下恢复结果与 pane 逐行一致（修复前「可见区未满」fail）。
- 单测 `tests/unit/resize-resync.test.ts`：debounce 合并、同尺寸不触发、变过尺寸又变回仍触发、等待首次 attach 且不重叠、dispose 能取消、失败后不卡住后续 resync。
- 集成：snapshot body 不以换行结尾（修复前 1 fail）。
- 集成 `attach-snapshot-alignment.test.ts`：`resync` 先 announce 再发 snapshot，之后实时字节继续送达；已退订的订阅者不会被复活；legacy 路径不做事。
- E2E：去掉 resize 用例的 fixme；新增「resize resync keeps a scrolled-up viewport scrolled up」（向上翻 60 行后 resize，resync 发生，屏幕一致，lfb 仍为 60）。两者各 `--repeat-each=20`。
- 测试辅助函数修正：`openSession` 之后，desktop view 可能在会话列表加载完成时恢复「上次会话」，测试会话的 tab 因此被隐藏，恢复决策按 INV-5 挂起，滚动用例在诊断中 4/4 失败。现在轮询直到 probe 报告 `connected/true`（可见）。
- 全量 unit/integration 与 E2E（desktop + emulator）全绿。

## 部署与发布

服务端与 web 一起构建发布。旧页面不带 `resync=1`，行为不变；刷新后生效。合入后 `deploy-dogfood`，在 dogfood 上用 Playwright 改变视口尺寸，跑 oracle 确认 diffRows=0。prod 由人前移 `accepted` 后生效。
