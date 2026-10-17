# hub 调 tmux 时剥离 hub 私有 env

> RSI loop 第 1 轮自主选题（backlog P0）。loop 级目标已与用户确认；本 spec 记录 agent 自己得出的需求。

## 需求

tmux server 启动时，会把启动它的进程的 environment 快照进 global env，之后每个 session 里的 shell / agent 都会继承这份 env。hub 由 systemd 带着 `hub.env` / `dogfood.env` 运行，tmux server 又由 hub 拉起，于是：

- `GATE_INJECT_KEY`（gate 身份头签名密钥，可以用来伪造任意 uid）、`TMUX_HUB_SUGGEST_TOKEN`、`TMUX_HUB_UPLOAD_BROKER_TOKEN` 落进了每个 session 的 env；
- `TMUX_HUB_HOST`、`TMUX_HUB_DB_PATH`、`TMUX_HUB_VOICE_DB_PATH`、`TMUX_HUB_IMAGE_DIR` 等 prod 配置也一并落入。在 session 里跑测试时，测试会绑到 prod HOST、打开 prod voice.db。

实测（2026-10-17）：`tmux -L hub-dogfood show-environment -g` 包含上述全部 key。

## 设计

1. 新增 `src/server/tmux-env.ts`：
   - `isHubPrivateEnvKey(key)`：`GATE_*` 一律视为私有；`TMUX_HUB_*` 除 CLI 路由所需的 4 个 key 外也视为私有。保留的 4 个是 `TMUX_HUB_SOCKET`、`TMUX_HUB_PORT`、`TMUX_HUB_SECRET_PATH`、`TMUX_HUB_ADMIN_SECRET_PATH`：它们不是凭据，`bin/tmux-hub tui` 在 session 内要靠它们找到这个 session 所属的 hub（dogfood 还是 prod）。
   - `tmuxChildEnv()`：基于**当前**的 `process.env` 构造子进程 env，去掉私有 key 和 `TMUX`。
2. `tmux()`（`tmux-cmd.ts`）调用 `Bun.spawn` 时显式传入 `env: tmuxChildEnv()`。hub 拉起的所有 tmux client/server 都经过这里。附带效果：运行时对 `process.env` 的修改（例如测试 preload 设置的 `TMUX_TMPDIR`）现在也会传给 tmux。此前 Bun 用的是启动时的 env。
3. `bootstrapTmuxHooks` 结束时运行 `show-environment -g`，对其中的私有 key 逐个执行 `set-environment -gu`。这一步用来清理旧版 hub 已经污染过的、仍在运行的 server。它在 hub 启动时和 `/system/start-tmux-server` 中都会执行，日志只记录 key 名，不记录值。

选用「前缀 denylist + 小 allowlist」，没有用全量白名单。原因是 session 里的 shell 需要完整的用户 env（PATH、LANG、XDG_* 等），而白名单维护成本高，还会误伤。hub 私有配置统一使用 `TMUX_HUB_` 和 `GATE_` 前缀，这是已有约定。

不在范围内：已经在运行的 session 里，进程已继承的 env 无法回收，只能等进程重启。E2E 和单测对外部 env 的护栏另开 PR 处理。

## 验收

- unit `tests/unit/tmux-env.test.ts`：私有 key 被剥离；PATH、HOME、LANG、TMUX_TMPDIR 和 4 个路由 key 保留；`TMUX` 被剥离。
- integration `tests/integration/tmux-env-scrub.test.ts`：process.env 带凭据时，经 `tmux()` 启动的新 server，其 global env 里不含凭据值；在已被污染的 server 上，执行 bootstrap 后私有 key 消失、路由 key 保留，重复执行幂等。
- 全量 unit/integration 与 E2E 回归通过。

## 部署

合入后部署 dogfood（`deploy-dogfood`）。hub 重启时 bootstrap 会清理 `hub-dogfood` server 的 global env。验证方法：`tmux -L hub-dogfood show-environment -g` 中不再出现 `GATE_INJECT_KEY` 和 `*_TOKEN`。prod 按人工验收节奏 promote，promote 后 prod server 同样会自动完成清理。
