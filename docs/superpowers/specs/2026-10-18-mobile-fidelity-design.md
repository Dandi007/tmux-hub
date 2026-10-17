# 手机宽度下的回传保真：可见区 capture 不再 `-J`，fidelity oracle 增加移动视口

## 需求（RSI loop 自定，backlog P2「移动视口下 fidelity suite 红」，第 18 轮发现）

手机是主要使用场景之一，但回传保真 oracle 只在桌面视口（1440x900）跑。第 18 轮把 fidelity suite 放到 Pixel 7 视口（mobile view，约 52–56 列）下运行，8 个用例 6 个红。

## 根因

1. **产品 bug**（`SessionBroadcaster.captureSnapshot`）：可见区用 `capture-pane -J`。注释假设「tmux 会按当前尺寸 reflow」，但实测 tmux 3.6 在窗口**加宽**时不会把在较窄宽度下折行的行重新合并，它们在 tmux 屏幕上仍是两行（独立 tmux 实验：45 列输出 49 宽的 CJK 行，resize 到 56 列，`capture-pane -p` 仍是两行，`-J` 合成一行）。snapshot 因此比 tmux 少了若干可见行，整屏错位；resync 走的是同一个 capture，所以修不好。桌面从 80 列加宽到约 197 列时很少有折行，一直没暴露；手机窄屏折行很常见（会话先在窄宽度下输出，之后被更宽的客户端 attach 或 resize，即会命中）。
2. **测试侧**：
   - suite 的 `openSession` 不等会话进入列表（新会话的 ws 会被 410 拒绝并重连），mobile view 在列表加载后还会异步恢复 last-session，可能把 suite 刚打开的会话切走（mobile 只有一个 terminal，probe 随之消失）。
   - 窄屏下 vim 打开文件时的文件信息超长，触发「Press ENTER」提示。

## 设计

- 可见区 capture 去掉 `-J`，与 tmux 屏幕逐行对应（pane 已 pin 到 client 尺寸，不需要 client 再折行；恰好占满一行的行写 CRLF 也不会多出空行）。history 保留 `-J`，由 client 按自己的宽度重新折行。注释同步更正。
- `fidelity-suite.ts`：`openSession` 先把 last-session 设为目标会话，并等目标出现在列表里（`[data-session]`，desktop tab 和 mobile picker 共用）；vim 用 `--cmd "set shortmess+=F"`。
- `playwright.config.ts` 新增 `emulator-mobile` project：Pixel 7 视口跑 `emulator-fidelity.e2e.ts`，`deviceScaleFactor: 1`（CDP 的 DPR 模拟会让 xterm canvas 绘制错位，第 18 轮判定为假象）。CI 的 E2E 命令加上该 project，不排除任何用例。

## 验收

- 新集成测试「rows wrapped at a narrower width stay split after widening」（真实 tmux，headless xterm 回放 snapshot 后逐行比对 + 光标 + history）改前红，改后绿。
- `emulator-mobile` + `emulator` 的 fidelity suite `--repeat-each=3` 全绿（改前 mobile 6/8 红）。
- 全量 unit/integration 与 E2E 全绿；CI 绿。
- dogfood：造一个在窄宽度下折行的 shell 会话，再以更宽的尺寸 attach，oracle diffRows=0。

## 部署

合入后 `deploy-dogfood`；不涉及 prod。
