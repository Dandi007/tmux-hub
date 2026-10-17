# tmux-hub — Claude Code 项目指引
> canonical agent 入口见 [AGENTS.md](AGENTS.md)；本文件为 Claude Code 专用补充。

详细的仓库结构、开发流程、测试规范见 [AGENTS.md](AGENTS.md)。

## 部署拓扑（双平台）

| 轴 | macOS | NUC (Linux) |
|---|---|---|
| 实例 | prod + dogfood 双实例（金丝雀） | prod + dogfood 双实例（金丝雀） |
| 进程管理 | `svc` | systemd user unit `tmux-hub.service` |
| prod checkout | `~/code/tmux-hub`（钉已验证 commit） | `/data/code/self/tmux-hub`（detached，钉 `accepted` tag） |
| dogfood checkout | `~/code/worktrees/tmux-hub/dogfood-live` | `/data/code/worktrees/tmux-hub/dogfood-live`（detached，跟 origin/main） |
| 部署命令 | `deploy-dogfood` → 验证 → `promote` | `deploy-dogfood` → 验证 → `promote`（前移 `accepted` 即人类验收）；`drift` 查差距 |
| 重启 | `svc restart tmux-hub` | `systemctl --user restart tmux-hub.service` |
| 状态 | `svc status all` | `systemctl --user status tmux-hub.service` |
| 日志 | `svc logs tmux-hub` | `journalctl --user -u tmux-hub.service` |

prod 监听地址来自 `~/.config/tmux-hub/hub.env` 的 `TMUX_HUB_HOST` / `TMUX_HUB_PORT`（NUC 绑非 loopback 地址）；健康检查 `GET /system/health`，`deploy/instances.zsh` 会自动读取。

## 重启安全规则

### 只用平台对应的进程管理入口

macOS 用 `svc`，NUC 用 `systemctl --user`。

### 绝对禁止

- `kill $(lsof -ti :3101)` — lsof 返回 LISTEN + ESTABLISHED 连接，会误杀 cloudflared 等通过该端口代理流量的进程
- `lsof -ti :3101 | xargs kill` — 同上
- 直接 `kill PID` —（macOS）wrapper 把 SIGTERM 视为正常退出，supervisor 永久停止
- `nohup bun run start &` — 产生孤儿进程，占用端口阻塞正常启动

## 部署新版本

### NUC (Linux)

**dogfood 跟 main 头，prod 只部署 `accepted` tag。** 合入 main 不会进 prod。

```bash
zsh deploy/instances.zsh deploy-dogfood          # origin/main → build → restart tmux-hub-dogfood.service → 核对运行 commit
zsh deploy/instances.zsh drift                   # dogfood 领先 accepted 几个合入、期间部署几次、各是什么
zsh deploy/instances.zsh promote [<ref>]         # 人类验收：accepted 前移到 dogfood HEAD（或 ref）并推远端 → deploy-prod
zsh deploy/instances.zsh deploy-prod             # 重新部署当前 accepted（不前移）
```

dogfood 实例：`3102` · socket `hub-dogfood` · env `~/.config/tmux-hub/dogfood.env`（systemd 不展开 `$HOME`，写绝对路径）· unit 模板 `deploy/systemd/tmux-hub-dogfood.service` · 子域 `hub-dogfood.qinglinzhang.top`（gate app `hub-dogfood`）。

### macOS（金丝雀流程）

**dogfood 跟 main 头，prod 手动 promote 已验证 commit。**

```bash
# dogfood：拉 origin/main → build → restart（先在 dogfood 上验证改动）
zsh deploy/instances.zsh deploy-dogfood

# prod：将 dogfood 当前 HEAD（或指定 ref）promote 到生产
zsh deploy/instances.zsh promote
zsh deploy/instances.zsh promote <commit-sha>  # 指定特定 commit
```

worktree 路径通过 `TMUX_HUB_DOGFOOD_WT` / `TMUX_HUB_PROD_WT` 环境变量覆盖（默认见脚本头部）。

### macOS 双实例对照

| 轴 | prod | dogfood |
|---|---|---|
| svc 名 | `tmux-hub` | `tmux-hub-dogfood` |
| 端口 | 3101 | 3102 |
| tmux socket | 默认（`tmux`） | `tmux -L hub-dogfood` |
| DB | `~/.cache/tmux-hub/managed-sessions.db` | `~/.cache/tmux-hub-dogfood/managed-sessions.db` |
| secret | `~/.config/tmux-hub/hub.secret` | `~/.config/tmux-hub/dogfood.secret` |
| gate app | `hub` | `hub-dogfood` |
| 子域 | `hub.qinglinzhang.top` | `hub-dogfood.qinglinzhang.top` |
| env 文件 | `~/.config/tmux-hub/hub.env` | `~/.config/tmux-hub/dogfood.env` |
| example | `deploy/hub.env.example` | `deploy/dogfood.env.example` |
