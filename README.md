# tmux-hub

**在手机或任意浏览器上实时查看、操作 Mac 上运行的 tmux session——无需 SSH、无需 VPN、不丢历史输出。**

用于解决一个具体问题：Claude Code / Cursor 等 AI agent 在 Mac tmux session 里长时间跑任务时，人不在电脑前只能干等。tmux-hub 让你在手机上就能看到实时输出、发送按键、新建或关闭 session，随时掌控进度。

---

## 产品目标

### 核心功能

| 功能 | 说明 |
|------|------|
| **实时终端输出** | 浏览器内 xterm.js 终端，通过 WebSocket 接收 tmux pane 的实时输出流 |
| **键盘输入** | 移动端：textarea 多行输入 + 特殊键工具栏（Esc / Tab / ^C / 方向键）；桌面端：原生 xterm 键盘直通 |
| **Session 管理** | 查看全部 session、切换、重命名、关闭（带确认弹窗）、一键新建 |
| **图片上传** | 选择文件或粘贴剪贴板图片 → 上传到服务端 → 把路径注入到当前 pane（给 AI agent 看图用） |
| **断线自愈** | WebSocket 心跳 + 指数退避重连 + 后台冻结恢复，iOS Safari / PWA 全覆盖 |
| **PWA 安装** | 支持 Chrome / Edge / Brave 安装到桌面 / Dock，standalone 模式无地址栏 |

### 设计原则

- **只读优先**：移动端终端默认只读（read-only），输入通过独立的 textarea 走 send-keys，避免误触
- **不侵入 tmux**：不修改用户的 tmux 配置，只用 `pipe-pane`（输出录制）和 `send-keys`（输入注入）
- **永远在录**：session 被发现的瞬间就开始 pipe-pane 录制，不依赖有没有浏览器连着

---

## 技术实现

### 架构总览

```
┌──────────────────────────────────────────────────────────────┐
│  Browser (Desktop / Mobile / PWA)                            │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │ xterm.js│  │ SSE 事件 │  │ session  │  │ 图片上传     │  │
│  │ 终端渲染│  │ 实时同步 │  │ 管理 UI  │  │ (file/paste) │  │
│  └────┬────┘  └─────┬────┘  └─────┬────┘  └──────┬───────┘  │
│       │WS           │GET /events  │POST           │POST      │
├───────┼─────────────┼─────────────┼───────────────┼──────────┤
│  Bun Server (Hono)  │             │               │          │
│  ┌────┴────┐  ┌─────┴────┐  ┌────┴─────┐  ┌─────┴───────┐  │
│  │Broadcast│  │ Registry │  │ Session  │  │ Image       │  │
│  │Registry │  │ (2s poll)│  │ Control  │  │ Upload      │  │
│  └────┬────┘  └─────┬────┘  └────┬─────┘  └─────────────┘  │
│       │pipe-pane    │list-sessions│send-keys/kill/rename     │
├───────┼─────────────┼─────────────┼──────────────────────────┤
│  tmux server        │             │                          │
│  ┌──────────────────┴─────────────┴────────────────────────┐ │
│  │  session-A    session-B    session-C    ...              │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### 关键机制

**输出广播（pipe-pane）**：tmux 原生的 `pipe-pane` 把 pane 输出重定向到日志文件，server 以 5ms 间隔轮询文件增量，通过 WebSocket 推给所有连接的浏览器。内存中维护一个 1MB ring buffer 用于 attach 时的快速回放。

**Session 发现（registry poll）**：每 2 秒调用 `tmux list-sessions`，diff 出新增 / 删除 / 变化的 session，通过 SSE 推送给前端。前端不需要轮询。

**输入路由（send-keys）**：浏览器侧按键通过 WebSocket JSON 消息发到 server，server 调用 `tmux send-keys` 注入到对应 pane。每个 session 串行化，保证按键顺序。

**心跳与重连**：client 每 15s 发 ping，server 立即回 pong。5s 无 pong 判定断线，指数退避重连（500ms → 30s，最多 8 次），之后进入 dead 状态每 60s 探测。iOS 后台恢复时额外触发一次探测。

**认证**：server 启动时生成或读取一个 secret file，client 通过 `/system/auth-check` 获取 secret 后缓存到 sessionStorage，后续请求通过 `X-Hub-Secret` header 鉴权。生产部署可前置 Cloudflare Access 做边缘认证。

### 技术栈

| 层 | 技术 |
|----|------|
| Server runtime | Bun |
| HTTP framework | Hono |
| Web build | Vite + vite-plugin-pwa |
| Terminal rendering | xterm.js (CanvasAddon) |
| Config validation | Zod |
| Test | bun:test (unit/integration) + Playwright (E2E) |
| PWA | Workbox precaching + injectManifest |

---

## 部署指南

### 前置条件

- macOS（tmux-hub 设计为跑在你的开发 Mac 上）
- [Bun](https://bun.sh) >= 1.0
- tmux（macOS 自带或 `brew install tmux`）

### 快速开始（本地开发）

```bash
git clone https://github.com/Dandi007/tmux-hub.git
cd tmux-hub
bun install
bun run dev          # http://127.0.0.1:3101
```

### 生产部署

#### 1. 准备配置文件

```bash
mkdir -p ~/.config/tmux-hub

# 环境变量
cp deploy/hub.env.example ~/.config/tmux-hub/hub.env
# 编辑 hub.env，必须设置 TMUX_HUB_REPO_DIR 为仓库绝对路径

# Session 模板
cp deploy/templates.yaml.example ~/.config/tmux-hub/templates.yaml
# 按需编辑 templates.yaml
```

#### 2. 配置说明

`hub.env` 主要变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TMUX_HUB_REPO_DIR` | **必填** | 仓库绝对路径 |
| `TMUX_HUB_PORT` | 3101 | 监听端口 |
| `TMUX_HUB_HOST` | 127.0.0.1 | 监听地址 |
| `TMUX_HUB_TEMPLATES_PATH` | `~/.config/tmux-hub/templates.yaml` | 模板配置路径 |
| `TMUX_HUB_SECRET_PATH` | `~/.config/tmux-hub/hub.secret` | 认证密钥路径 |
| `TMUX_HUB_LOG_DIR` | `~/.cache/tmux-hub/logs` | pipe-pane 日志目录 |
| `TMUX_HUB_IMAGE_DIR` | `~/Pictures/tmux-hub` | 图片上传目录 |
| `TMUX_HUB_DEV_BIND_SECRET` | 1 | SPA 自动绑定 secret（生产前置 CF Access 时保持 1） |

`templates.yaml` 定义一键新建 session 的模板：

```yaml
templates:
  - id: shell
    name: "新建 zsh"
    cwd_choices: ["~"]
    cmd: "zsh"

  - id: kb-cc
    name: "知识库 cc"
    cwd_choices: ["/path/to/your/knowledge-base"]
    cmd: "zsh -ic 'cc -f; exec zsh -i'"
```

> **注意**：`cmd` 中的 shell function / alias 必须用 `zsh -ic '...'` 包裹，因为 tmux 通过 `/bin/sh -c` 执行命令，不加载 zshrc。

#### 3. 构建 & 启动

```bash
cd /path/to/tmux-hub
bun install
bun run build        # 构建前端到 dist/web/

# 方式 A：直接启动
bun run start

# 方式 B：用 wrapper（带自动重启）
zsh deploy/tmux-hub.zsh
```

wrapper 脚本提供 supervisor 功能：crash 后 2s 重启，连续 5 次快速 crash 则放弃。

#### 4. 外网访问（可选）

tmux-hub 默认监听 127.0.0.1，要从手机访问需要做内网穿透：

- **Cloudflare Tunnel**（推荐）：`cloudflared tunnel --url http://127.0.0.1:3101`，配合 Cloudflare Access 做认证
- **自建反代**：Nginx / Caddy 反向代理到 3101 端口，自行处理 HTTPS 和认证

#### 5. 安装为 PWA

在 Chrome / Edge / Brave 访问部署地址后，地址栏会出现「安装 tmux-hub」按钮。安装后以 standalone 窗口运行，Dock 右键可用「新会话」和「会话列表」快捷入口。

---

## 测试

```bash
bun test                    # unit + integration (74+ tests)
bun run test:e2e            # Playwright E2E (35+ tests, desktop/mobile/PWA)
```

详细的测试规范和开发流程见 [AGENTS.md](AGENTS.md)。

Spec 和实现计划见 [`docs/superpowers/`](docs/superpowers/)。
