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
