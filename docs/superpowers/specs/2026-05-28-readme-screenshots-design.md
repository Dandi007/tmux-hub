# README 截图区设计

## §1 第一性原理：要什么

仓库刚转 public，README 现在只有文字描述。访客（包括路过 GitHub 搜索的人）在 30 秒内 **看不到 tmux-hub 实际长什么样**——既不知道桌面 UI 怎么排版，也不知道手机端怎么展示终端。

要的：在 README 顶部、`产品目标` 章节之前，加一个「界面预览」区，并排展示桌面端与移动端两张截图，让访客一眼看到 UI 形态。

约束：

- 截图必须**可重新生成**，不能是手工 PNG（rot 风险）
- 生成命令必须本地一行可跑，不依赖额外环境
- 截图源走 Playwright（既有 E2E 栈），不引入新依赖

## §2 现状与根因

- `scripts/screenshot-compare.ts` 已存在，但用途是 before/after diff（输出到 `screenshots/{before,after}/`），命名与目录都不适合 README 资产
- 没有可重复运行的「生成 README 截图」入口
- README 当前 0 张截图

## §3 方案设计

```
+ scripts/capture-readme.ts            # playwright test：desktop + mobile 两个 case
+ scripts/capture-readme.config.ts     # 独立 config，无 webServer，base URL = http://127.0.0.1:${SHOT_PORT:-3101}
+ docs/screenshots/desktop.png         # 1440 × 900 全视口
+ docs/screenshots/mobile.png          # 390 × 844 全视口（iPhone 14 viewport）
  package.json                         # 新增 scripts.screenshots:readme
  README.md                            # 新增「界面预览」section
```

执行流：

```
用户/CI                                  本机
─────────────────────────────────────────────────────────────
bun run dev (或已起 svc tmux-hub)  →    listen :3101
bun run screenshots:readme         →    playwright (chromium)
                                        ├─ goto / → fetch /system/auth-check
                                        ├─ store secret in sessionStorage
                                        ├─ goto / 再次 (此次已鉴权)
                                        └─ screenshot(viewport) → docs/screenshots/*.png
```

鉴权依赖 `TMUX_HUB_DEV_BIND_SECRET=1`，这是本机 `~/.config/tmux-hub/hub.env` 的默认值；CI 走 dev 模式也满足。

不使用 `waitForLoadState("networkidle")`：tmux-hub 主页有持续 SSE/WS 连接，永远不会进入 idle 状态，会顶住 30s 测试超时。改用 `domcontentloaded` + 固定 `waitForTimeout(2000)` 让 xterm 与 layout 完成首帧。

## §4 改动清单

| 文件 | 改动 |
|------|------|
| `scripts/capture-readme.ts` (新) | Playwright test，2 个 case：desktop 1440×900 + mobile 390×844；共用 `bootstrapAuth` |
| `scripts/capture-readme.config.ts` (新) | Playwright config，testMatch 仅 capture-readme.ts，无 webServer |
| `docs/screenshots/desktop.png` (新) | 由脚本生成的桌面端截图 |
| `docs/screenshots/mobile.png` (新) | 由脚本生成的移动端截图 |
| `package.json` | 新增 `scripts.screenshots:readme` |
| `README.md` | intro 之后、`产品目标` 之前插入「界面预览」表格 + 一行重生成命令 |

## §5 测试计划

- 手动：本机 svc tmux-hub running on :3101 → `bun run screenshots:readme` → 两个 case PASS，`docs/screenshots/{desktop,mobile}.png` 文件 mtime 更新、内容 1440×900 / 390×844。
- 视觉验证：`docs/screenshots/desktop.png` 与 `mobile.png` 渲染正常（无白屏、无 401 错误页、xterm 与 sidebar / picker 可见）。
- 不新增 unit / integration / E2E：本 PR 只产文档资产 + 生成工具，不动业务逻辑或 server 路由。

## §6 非目标

- 不做 CI 自动重生（截图变化频率低，本地按需跑即可）
- 不做隔离 demo server（live svc 内容由作者把关；后续如需 reproducibility，再补 webServer + isolated tmux socket）
- 不做多语言 / 暗色模式 / 多 viewport 变体
