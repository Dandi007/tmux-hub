# README 截图区设计

## §1 第一性原理：要什么

仓库刚转 public，README 现在只有文字描述。访客（包括路过 GitHub 搜索的人）在 30 秒内 **看不到 tmux-hub 实际长什么样**——既不知道桌面 UI 怎么排版，也不知道手机端怎么展示终端。

要的：在 README 顶部、`产品目标` 章节之前，加一个「界面预览」区，并排展示桌面端与移动端两张截图，让访客一眼看到 UI 形态。

约束：

- 截图必须**可重新生成**，不能是手工 PNG（rot 风险）
- 生成命令必须本地一行可跑，不依赖额外环境
- 截图源走 Playwright（既有 E2E 栈），不引入新依赖
- **不能泄露任何用户实际工作内容**——不复用 live svc 上的真实 session 内容，而是临时 spawn 一个 demo session

## §2 现状与根因

- `scripts/screenshot-compare.ts` 已存在，但用途是 before/after diff（输出到 `screenshots/{before,after}/`），命名与目录都不适合 README 资产
- 没有可重复运行的「生成 README 截图」入口
- README 当前 0 张截图
- 历史踩坑：曾尝试直接对 live svc 的 active session 截图（PR #33），结果泄露了朋友部署 runbook 内容，已 force-push 回退

## §3 方案设计

```
+ scripts/capture-readme.ts            # playwright test：beforeAll 起 demo session，desktop + mobile 两个 case 切到 demo 截图，afterAll kill
+ scripts/capture-readme.config.ts     # 独立 config，无 webServer，base URL = http://127.0.0.1:${SHOT_PORT:-3101}
+ docs/screenshots/desktop.png         # 1440 × 900 全视口
+ docs/screenshots/mobile.png          # 390 × 844 全视口（iPhone 14 viewport）
  package.json                         # 新增 scripts.screenshots:readme
  README.md                            # 新增「界面预览」section
```

执行流：

```
beforeAll                                                tmux-hub server (live svc :3101)
─────────────────────────────────────────────────────────────────────────────────────────
GET /system/auth-check                              →    {secret, identity: "dev"}  (TMUX_HUB_DEV_BIND_SECRET=1)
POST /templates/shell/run   {cwd: "~"}              →    {name: "shell-<14-digit-ts>"}
                                                         ↓ 进 managedDb，registry poll (2s) 后发现
sleep 4s                                                 broadcaster prime + zsh rc 链加载完毕
tmux send-keys -t <demo> "clear" Enter                   ↓ 通过 pipe-pane 流到 WS
tmux send-keys -t <demo> "echo hello..." Enter
tmux send-keys -t <demo> "date" Enter
tmux send-keys -t <demo> "uname -srm" Enter
tmux send-keys -t <demo> "ls /tmp | head -6" Enter
sleep 1.5s

per test (desktop / mobile):
  page.goto / → fetch /system/auth-check → sessionStorage
  page.goto / 再次 (此次已鉴权)
  click 切到 demo session
  screenshot(viewport) → docs/screenshots/*.png

afterAll
─────────────────────────────────────────────────────────────────────────────────────────
tmux kill-session -t <demo>
```

**关键 selector**：

- desktop 切 session：`.tab-bar__tab[data-session="<demo>"]`（`data-session` 同时存在于 tab 与 term-slot 上，必须用 `.tab-bar__tab` 前缀去歧义）
- mobile 切 session：先点 `.session-picker__trigger` 打开 dropdown，再点 `.session-picker__item-name` 含 demo session 名的项

**send-keys 时机**：必须等 broadcaster prime（registry 2s poll）+ zsh rc 加载（重 plugin 链可达 2-3s），否则早期 keystroke 被吞或不入 pipe-pane 流。统一 sleep 4s 后再 send-keys。

**字符集**：send-keys 对 multibyte 字符（如 em-dash `—`）渲染为 `<00XX>` 控制码 artifact，命令文本一律 ASCII。

**不使用 `waitForLoadState("networkidle")`**：tmux-hub 主页有持续 SSE/WS，永远不 idle，会顶住测试超时。改用 `domcontentloaded` + `waitForTimeout`。

## §4 改动清单

| 文件 | 改动 |
|------|------|
| `scripts/capture-readme.ts` (新) | Playwright test，beforeAll/afterAll 编排 demo session，desktop + mobile 两个 case |
| `scripts/capture-readme.config.ts` (新) | Playwright config，testMatch 仅 capture-readme.ts，无 webServer，timeout 45s |
| `docs/screenshots/desktop.png` (新) | 由脚本生成的桌面端截图 |
| `docs/screenshots/mobile.png` (新) | 由脚本生成的移动端截图 |
| `package.json` | 新增 `scripts.screenshots:readme` |
| `README.md` | intro 之后、`产品目标` 之前插入「界面预览」表格 + 重生成命令说明 |

## §5 测试计划

- 手动：本机 svc tmux-hub running on :3101 → `bun run screenshots:readme` → 两个 case PASS、demo session 创建后 kill 干净、`docs/screenshots/{desktop,mobile}.png` 文件 mtime 更新。
- 视觉验证：两张截图不含真实工作 session 内容（无项目代号、域名、机器内部信息），terminal pane 显示 `echo / date / uname / ls /tmp` 的输出。
- 不新增 unit / integration / E2E：本 PR 只产文档资产 + 生成工具，不动业务逻辑或 server 路由。

## §6 非目标

- 不做 CI 自动重生（截图变化频率低，本地按需跑即可）
- 不做隔离 demo server（live svc + demo session 已足够安全；后续如需 CI 跑，再补 webServer + isolated tmux socket）
- 不做多语言 / 暗色模式 / 多 viewport 变体
- 不优化 zsh prompt rendering 与 pipe-pane 的命令-输出合并行（cosmetic，无信息丢失）
