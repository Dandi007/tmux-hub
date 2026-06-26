# tmux-hub — Claude Code 项目指引

详细的仓库结构、开发流程、测试规范见 [AGENTS.md](AGENTS.md)。

## 部署与重启安全规则

tmux-hub 作为 svc 管理的常驻服务运行在 tmux session 中。部署新版本或重启服务时：

### 必须使用 svc

```bash
# 重启 tmux-hub
svc restart tmux-hub

# 查看状态
svc status all

# 查看日志
svc logs tmux-hub
```

### 绝对禁止

- `kill $(lsof -ti :3101)` — lsof 返回 LISTEN + ESTABLISHED 连接，会误杀 cloudflared 等通过该端口代理流量的进程
- `lsof -ti :3101 | xargs kill` — 同上
- 直接 `kill PID` — wrapper 把 SIGTERM 视为正常退出，supervisor 永久停止
- `nohup bun run start &` — 产生孤儿进程，占用端口阻塞 svc 启动

### 部署新版本的正确流程

1. 在 worktree 中开发、commit、push
2. 在主 repo 合并：`cd /Volumes/Data/code/self/tmux-hub && git pull`
3. 构建：`cd /Volumes/Data/code/self/tmux-hub && bun run build`
4. 重启服务：`svc restart tmux-hub`
5. 验证：`svc status all` 确认所有服务 healthy

## 双实例（prod + dogfood）

**dogfood 跟 main 头，prod 手动 promote 已验证 commit**——这是金丝雀流程的核心。

### 实例对照

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

### deploy/instances.zsh 用法

```bash
# dogfood：拉 origin/main → build → restart（先在 dogfood 上验证改动）
zsh deploy/instances.zsh deploy-dogfood

# prod：将 dogfood 当前 HEAD（或指定 ref）promote 到生产
zsh deploy/instances.zsh promote
zsh deploy/instances.zsh promote <commit-sha>  # 指定特定 commit
```

脚本顶部常量 `DOGFOOD_WT` / `PROD_WT` 填各自 worktree 路径（或通过 `TMUX_HUB_DOGFOOD_WT` / `TMUX_HUB_PROD_WT` 环境变量覆盖）。
