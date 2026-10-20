# hub-sandbox：不经鉴权泄露 secret；pane 日志跟随 symlink（#150）

## 需求

Auditor issue #150 对 #134（hub-sandbox）的审查给出两条已复核的缺陷，本 PR 修这两条：

1. **严重**：`deploy/sandbox/sandbox.env.example` 开了 `TMUX_HUB_DEV_BIND_SECRET=1`，未鉴权的 `GET /system/auth-check` 因此直接返回 hub secret。pane 里的 agent 直连 `127.0.0.1:3103`，或者能访问 `100.64.0.6:3103` 的主机，都能拿到 secret，再调用全部写接口。
   - 线上复核（2026-10-20 14:2x）：对 `http://100.64.0.6:3103/system/auth-check` 发不带任何凭据的请求，返回 200 `{secret:<64 字符>, identity:"dev"}`。
2. **一般**：pane 日志目录对 agent 可写（`2770 hub:agent`），hub 打开 `<session>.log` 时会跟随 symlink。agent 把日志换成指向 hub 私有文件的 symlink 后，hub 会以自己的权限读取这个文件，并推给该会话的查看者。

## 设计

1. sandbox：
   - `sandbox.env.example` 删除该开关，并注明原因。
   - `entrypoint.sh` 在拆分 hub 环境变量时一律丢弃 `TMUX_HUB_DEV_BIND_SECRET`；如果设置了，就打一条 warning。这是纵深防御：已部署的 env 是从旧 example 拷出来的，重新部署后即使 env 里还留着这个开关，也不会生效。
   - 经 edge 的浏览器不受影响：gate 注入的身份走 `ident !== "local-secret"` 分支取得 secret，不依赖这个开关。
2. broadcaster：
   - 新增 `openLogForRead`，用 `O_RDONLY|O_CREAT|O_NOFOLLOW` 打开；文件不存在时照常创建，不再先用 `"a"` touch，那一步会跟随 symlink 去创建目标。打开后 `fstat` 校验：必须是普通文件，且 `nlink === 1`（拒绝硬链接）。不满足就关掉 fd 并抛错。
   - 打开动作挪进 start 的 try：失败时与读阶段失败走同一条清理路径，关闭刚打开的 pipe。原代码 open 本身抛错时，pipe 不会被关闭。
   - `poll()` 改用 `fstatSync(this.fd)`：start 之后路径再被换成 link 时，不会按 link 目标的大小误判「日志截短」。
   - 不校验 uid：sandbox 里日志属于 agent，普通部署里属于 hub 自己，没有统一的期望值。

不在本 PR 范围（issue 里标为疑似、未复核）：firewall 的 7898 回环规则；`deploy-sandbox` 无法回退到上一个镜像。

## 验收

- `tests/integration/broadcaster-log-nofollow.test.ts`：symlink、硬链接、dangling symlink 三种情况下 start 都被拒；fd 数不变；pipe 最后一次调用是 close；dangling symlink 的目标不会被创建。start 之后路径被换成 symlink，原文件的新字节照常推送，不触发 `replay_truncated`。普通日志行为不变。改动前 4 红 1 绿，改动后 5 绿。
- `tests/unit/sandbox-config.test.ts`：example 中没有这个开关；entrypoint 的丢弃列表里包含它。改动前 2 红。
- 全量 unit/integration 与 E2E（desktop、emulator）全绿。

## 部署

- dogfood：`deploy-dogfood` 之后，broadcaster 的改动随即生效。dogfood 的 env 保留 DEV_BIND_SECRET：dogfood 和 prod 的 pane 本来就是同一个用户，能直接读 secret 文件，不构成边界。
- hub-sandbox：`deploy-sandbox` 默认部署 `accepted`，需要人 promote 之后才会拿到本修复，而且要人执行。**已部署实例的 `~/.config/tmux-hub-sandbox/sandbox.env` 需要人删掉这个开关；由于它已经带着开关运行过，需要轮换 `/var/lib/hub/hub.secret`。** 验收：从 pane 内和从宿主直连 `/system/auth-check`，都应返回 401。
