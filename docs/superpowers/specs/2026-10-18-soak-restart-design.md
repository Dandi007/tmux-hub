# soak 脚本增加 hub 重启场景（`--restart-cmd`）

## 需求（RSI loop 自定，backlog P1「oracle 扩展」剩下的 hub 重启场景）

每次部署都会重启 hub，用户开着的浏览器必须自动重连，且重连后画面与 tmux 一致。第 9 轮在 dogfood 上手工验证过（oracle-restart.mjs，scratchpad），但没有可重复的工具。E2E 的 webServer 由 Playwright 管理，不方便中途重启，所以放在针对运行中实例的 `scripts/diag/soak.ts` 里。

## 设计

- `soak.ts` 新增 `--restart-cmd <shell 命令>`（需同时给 `--socket`）：
  1. 用同一个页面依次打开每个 tab，先做一遍 fidelity；
  2. 记录每个 tab 的 probe `replays`，执行命令（例如 `systemctl --user restart tmux-hub-dogfood.service`）；
  3. 轮询 `/system/health`，直到 `uptime` 小于重启前的值（证明进程确实换过），最长 30 秒，超时记为问题；
  4. 在**同一页面**（不 reload）上再做一遍 fidelity，并要求每个 tab 的 `replays` 都增加了，证明走过重连回放，而不是停留在旧画面。
- 屏幕比对抽成 `soak-judge.ts` 的纯函数 `screenDiff`（忽略行尾空白和尾部空行），加单测。
- 命令由调用者给出，脚本不内置任何 systemctl 或实例名。

## 验收

- `screenDiff` 单测。
- dogfood：`--cycles 0 --socket hub-dogfood --restart-cmd "systemctl --user restart tmux-hub-dogfood.service"` 输出重启前后两个会话都 ok，exit 0；用 `--restart-cmd true`（不真正重启）时报 `hub did not come back`，exit 1。

## 部署

只改诊断脚本与单测，运行时代码不变。
