# NUC dogfood 实例 + prod 钉 accepted tag

日期：2026-10-17
分支：`feat/nuc-dogfood-accepted-pin`

## §1 需求（与用户讨论确认）

tmux-hub 进入 agent 自主迭代（RSI loop）模式：agent 自行开 PR、自行合入 main、自行部署并使用 dogfood 实例；人类按需抽查，验收后才进 prod。由此要求：

1. NUC 上新增 dogfood 实例，跟 main 头，与 prod 后端完全隔离。
2. **合入 main 不得进 prod**：prod 只部署人类验收过的版本。
3. 任意时刻可回答「dogfood 距人类验收差了几个版本、都做了什么」。
4. 部署后可证实「在跑的进程就是刚部署的 commit」，而不是只看 health 200。

用户决定：prod 钉 `accepted` tag（初始 = 当前 prod 所跑的 `529f260`）；dogfood 经 `hub-dogfood.qinglinzhang.top`（gate app `hub-dogfood`）访问。

## §2 现状

- NUC 只有 prod：`tmux-hub.service` 直跑主 checkout `/data/code/self/tmux-hub`，`deploy-prod` = `git pull origin main` → build → restart。main 一动，下次部署即进 prod。
- macOS 已有金丝雀流程（dogfood 跟 main，`promote` 钉 commit 到 prod），但 macmini 已离线。`deploy-dogfood` / `promote` 在 Linux 上被 `_require_darwin` 拒绝。
- `/system/health` 只报 `ok/tmux/uptime`，无法区分新旧进程。
- `~/.config/tmux-hub/dogfood.env` 是 macOS 时期抄来的，路径指向 `/Volumes/...` 且用 `$HOME`——systemd `EnvironmentFile` 不展开 `$HOME`。

## §3 设计

| | prod | dogfood |
|---|---|---|
| checkout | `/data/code/self/tmux-hub`，detached @ `accepted` | `/data/code/worktrees/tmux-hub/dogfood-live`，detached @ `origin/main` |
| unit | `tmux-hub.service`（不变） | `tmux-hub-dogfood.service`（模板入库 `deploy/systemd/`） |
| 端口 / socket | `100.64.0.6:3101` / `tmux-hub` | `100.64.0.6:3102` / `hub-dogfood` |
| DB / secret / 日志 / 图片 | 原样 | `~/.cache/tmux-hub-dogfood/*`、`dogfood.secret` |

socket 必须独立：`pipe-pane` 每 pane 只能挂一个，两个 hub 共用 socket 会互相顶掉录制。

`deploy/instances.zsh`（Linux 分支）：

- `deploy-dogfood`：fetch → `checkout --detach origin/main` → install → build → restart → health → **核对 health.commit == HEAD** → 追加部署记录。
- `promote [<ref>]`：人类验收动作。`accepted` 前移到 dogfood HEAD（或 ref）并 force-push tag → `deploy-prod`。
- `deploy-prod`：fetch tag → `checkout --detach accepted` → build → restart → health → 核对 commit → 记录。
- `drift`：`accepted..dogfood HEAD` 的 first-parent 合入数与列表，以及 accepted 之后 dogfood 部署次数（读 `~/.local/state/tmux-hub/deploys.log`）。

git 是版本差的唯一事实源；部署记录只补充「部署了几次」。

server：`/system/health` 增加 `commit`（进程启动时 `git rev-parse HEAD`，失败为 `"unknown"`）。

## §4 验收

- [ ] `bun test`（含新增「health 上报启动 commit」单测）、E2E desktop+emulator 全绿
- [ ] `deploy-dogfood` 在 NUC 成功，health 的 commit 与 dogfood HEAD 一致
- [ ] prod 改为 detached @ `accepted`（= 529f260）后 `deploy-prod` 成功，现有 prod session 不丢（KillMode=process）
- [ ] `drift` 输出领先合入数与列表
- [ ] `https://hub-dogfood.qinglinzhang.top` 经 gate 登录后可用（edge 路由改指 NUC，另行在 edge-gateway 记录）

## §5 部署与发布条件

1. 合入后先在 NUC 打 `accepted` tag @ `529f260` 并推远端。
2. 写 NUC 版 `dogfood.env`（绝对路径，`TMUX_HUB_HOST=100.64.0.6`，`GATE_INJECT_KEY` 同 prod），安装 unit，`deploy-dogfood`。
3. 用本 PR 的 `deploy-prod` 把 prod 切到 `accepted`：代码不变，只换部署来源。
4. edge：`hub-dogfood` upstream `100.64.0.3:3102` → `100.64.0.6:3102`（只改一行，`caddy validate` 后 reload）。

回滚：`git -C /data/code/self/tmux-hub checkout main` 恢复跟 main；`systemctl --user disable --now tmux-hub-dogfood.service`。
