# Mobile Quick-Launch 按钮 — Design Spec

**Date:** 2026-05-23
**Status:** Draft (awaiting user review)
**Branch:** `feat/mobile-quick-launch`（worktree from `origin/main` @ `b02b9ce`，v0.3.0 之后）

---

## 1. 第一性原理：我们到底要什么

移动端用户在 iPhone / iPad 上点开 tmux-hub 时，**只想一键就能起一个新的 Claude Code 会话**，不想：

- 手动 cd 到知识库目录（路径长、移动端键盘难打）
- 手动敲 `cc -f`（命令短但仍要切到英文输入法）
- 从 session list 里挑某条"母模板" session 然后 detach 重连

目前移动端**完全没有"新建 session"入口**——桌面端 `template-drawer` 里那一排"新建 zsh"按钮在 mobile-view 里被砍掉了。这次要补一个：

> 移动端 toolbar 上一个固定按钮，点击 → 服务端起一个新 tmux session，自动 cd 到知识库目录，自动跑 `cc -f`，前端自动切到这个新 session。

---

## 2. 用户故事

**S1**：用户在地铁里掏出 iPhone，打开 `https://tui.qinglinzhang.xyz`，**点 toolbar 上的「+」按钮一次**，1-2 秒后画面切到一个新 session，已经在知识库目录下、`cc -f` 已经在跑、可以直接输入第一句 prompt。

**S2**：用户在桌面 Chrome 上也能在 `template-drawer` 里看到这条"知识库 cc"按钮（桌面端**复用**同一条 template，不做特殊隐藏）。

**S3**：另一个人 clone 这个 repo 没有配 `~/.config/tmux-hub/templates.yaml` 里的对应 template，点这个按钮会看到 toast「未配置快速启动模板，请在 templates.yaml 添加 `kb-cc`」，**不崩溃、不静默失败**。

---

## 3. 范围 / 非目标

**In scope**

- 移动端 toolbar 加一个 quick-launch 按钮。
- 按钮固定调用一个**约定 id** 的 template（`POST /templates/kb-cc/run`）。
- 前端拿到新 session name 后自动切到该 session（复用现有 `openSession()` 路径）。
- `deploy/templates.yaml.example` 加 commented-out 示例，说明 `kb-cc` 是移动端 quick-launch 的契约 id。
- 友好降级：template id 找不到时 toast 提示。
- Loading 态：请求飞行期间按钮 disabled，避免重复触发。
- 单元测试 + Playwright E2E（至少一条 happy path）。

**Out of scope**（这一版不做）

- 不在后端引入 `surface: mobile|desktop|all` schema 字段（桌面也看到这条按钮，已与用户对齐）。
- 不引入用户在前端"自定义 cwd / cmd" 的 UI（移动端要的就是零输入）。
- 不解决"`cc -f` 退出后 session 是否保留 shell"——由用户在自己机器的 `templates.yaml` 里通过 `cmd` 自行选择（`cc -f` vs `zsh -ic 'cc -f; exec zsh'`）。
- 不动 `~/.config/tmux-hub/templates.yaml`（用户机器配置，不在 repo 内）。
- 不解决 desktop xterm 底部不可见 / CF Access JWT stub 等 Phase-2 backlog。

---

## 4. 架构决策

### 4.1 复用现有 `/templates/:id/run` 通道（**核心**）

后端 0 改动。

- 现有 endpoint：`POST /templates/:id/run`，body `{ cwd: string }`（**必填**，server 端 `TemplateRunner.run` 校验 `cwd in t.cwd_choices`，不传或不匹配会 400）。返回 `{ name: string }`（新 session 名）。
- 实现在 `src/server/template-runner.ts`（约定接口，已被 `template-drawer.ts` 验证可用）。
- 移动端按钮 **mount 时一次性 GET `/templates`**，找到 `kb-cc` 缓存其 `cwd_choices[0]`；点击时 POST `/templates/kb-cc/run` body `{cwd}`（与桌面 `template-drawer.ts` 完全对齐）。
- 如果 mount 时 `/templates` 列表里没有 `kb-cc`：按钮 disabled + `title` 提示「未配置 kb-cc template」，点击 no-op。

### 4.2 契约 id 常量集中定义

在 `src/shared/protocol.ts` **追加**一个常量（同 repo 现有 protocol 常量并列，**不新建文件**——保持 share layer 紧凑）：

```ts
/**
 * 移动端 quick-launch 按钮硬编码调用的 template id。
 * 用户机器 ~/.config/tmux-hub/templates.yaml 必须存在这条 template，
 * 否则按钮点击会 404 + toast 提示。
 */
export const MOBILE_QUICK_LAUNCH_TEMPLATE_ID = "kb-cc";
```

前端和（未来可能的）后端校验都从这一处引用，避免字符串散落。

### 4.3 不修 schema、不修 `/templates` API

- 现有 zod schema (`TemplateConfig`) 字段不动。
- `kb-cc` template 在 `/templates` 列表里跟 `shell` 平级——桌面端 template-drawer 会自然把它渲染成第二个按钮。

### 4.4 个人路径只在用户机器、不进 repo

- repo 里 `deploy/templates.yaml.example` 加 commented-out 示例（用占位路径或 `~/Documents/...`），不写用户的真实 iCloud 绝对路径。
- 用户机器的真实 `~/.config/tmux-hub/templates.yaml` 是 deploy artifact，不受 repo 影响。
- 这与正在进行的 `chore/sanitize-personal-refs` 方向一致——不引入新的个人路径。

---

## 5. UI 设计

### 5.1 按钮位置

移动端底部 toolbar，**`✎` 右侧**、`special-keys-bar` 左侧：

```
┌─ header ──────────────────────┐
│ [ session select ▾ ]          │
└───────────────────────────────┘
│           terminal            │
│              ...              │
└───────────────────────────────┘
│ ✎  [+]  special-keys          │  toolbar
└───────────────────────────────┘
```

### 5.2 按钮外观

- 文案：`+`（或 emoji `🚀`，最终颜色 / 字体跟现有 toolbar 按钮一致，复用 `.mobile-toolbar__toggle` 风格 class）
- `aria-label="新建知识库 Claude Code 会话"`
- disabled 态：请求飞行中灰掉
- 视觉权重不应高于 session select / ✎ —— 它是 quick path，不是首要操作

### 5.3 交互流程

```
按钮 mount
  → GET /templates
    ├─ 找到 kb-cc → 缓存 cwd_choices[0]，按钮 enabled
    └─ 未找到     → 按钮永久 disabled，title="未配置快速启动模板（kb-cc）"
                  → 后续若 user 想点：toast 提示并指向 templates.yaml

按钮点击（仅 enabled 时）
  → 按钮 disabled 防重复点击
  → POST /templates/kb-cc/run with `{cwd: <cached cwd>}`
    ├─ 200 OK → 拿到 { name } → onStarted(name)（mobile-view 调用方接住，走 openSession）
    │                         → 按钮恢复 enabled
    ├─ 404    → toast「未配置快速启动模板：在 ~/.config/tmux-hub/templates.yaml 加 id: kb-cc」
    │        → 按钮恢复 enabled（template 可能被运行时改了）
    └─ 其他   → toast「启动失败：<msg>」（复用 desktop template-drawer 错误处理）
                → 按钮恢复 enabled
```

切换 session 走 `mobile-view.ts` 现有 `openSession()`，复用 pending-target + serial transition queue（不引入新的 race window）。

---

## 6. 改动清单

| 文件 | 改动 | 行数估计 |
|------|------|---------|
| `src/shared/protocol.ts` *(或新建 `src/shared/mobile-contract.ts`)* | 加 `MOBILE_QUICK_LAUNCH_TEMPLATE_ID = "kb-cc"` 常量 | +5 |
| `src/web/mobile/quick-launch-button.ts` *(新建)* | 渲染按钮 + POST + 错误处理 | ~50 |
| `src/web/mobile/mobile-view.ts` | toolbar 加 quick-launch 按钮挂载点；接 `onStarted(name) → openSession(name)` | +5~10 |
| `src/web/style.css`（或对应 mobile 段） | 按钮 disabled / hover 样式（如复用现有 class 则无改动） | 0~10 |
| `deploy/templates.yaml.example` | 加 commented-out `kb-cc` 示例 | +6 |
| `tests/mobile-quick-launch.test.ts` *(新建)* | 单元 / 集成测试：按钮点击 → fetch 调用、404 toast 路径 | ~40 |
| `tests/e2e/mobile-quick-launch.e2e.ts` *(新建)* | Playwright happy path：点按钮 → session 出现在 list、切过去 | ~30 |
| `docs/superpowers/specs/2026-05-23-mobile-quick-launch-design.md` | 本文件 | (本文) |

**后端代码改动：0 行。** 这是这版的关键属性，最小爆炸半径。

---

## 7. 测试策略

### 7.1 单元 / 集成测试 (`bun test`)

Bun test 不带 DOM（仓库未配 happy-dom / jsdom）。因此 quick-launch 逻辑要**抽到一个 pure async helper**（如 `runQuickLaunch(fetcher, onStarted, onError)`），DOM 渲染由 e2e 覆盖。

helper 单测覆盖：

- 200 响应 → 调 `onStarted(name)`，不调 `onError`。
- 404 响应 → 调 `onError("not-configured", ...)`，不调 `onStarted`。
- 500 / 网络错误 → 调 `onError("runtime", msg)`，不调 `onStarted`。
- `cwd` 来自调用方传入的 cached 值（helper 不再调 GET /templates，让 mount-time 逻辑处理）。

### 7.2 E2E (`bun run test:e2e`)

- happy path：在测试用 `templates.yaml`（用 `TMUX_HUB_SOCKET` 隔离的测试 hub）里准备一条 `id: kb-cc` template（cwd=`$HOME`, cmd=`true`），点击按钮，断言：
  - 新 session 出现在 `/sse` snapshot
  - 移动端 select 切到该 session
  - terminal 完成 attach

### 7.3 不做的测试

- 不测真实 `cc -f` 启动（依赖外部二进制）。
- 不测真实知识库路径（mock 路径即可）。

---

## 8. 验收标准

- [ ] 移动端 toolbar 出现 quick-launch 按钮（位置与上面 ASCII 一致）
- [ ] 用户机器配好 `kb-cc` template 后点击按钮：1-2 秒内自动切到新 session，cwd 是知识库目录，`cc -f` 已在跑
- [ ] 未配置 template 时点击按钮：toast 提示明确，不静默、不崩
- [ ] 桌面端 `template-drawer` 自然多出一条 "知识库 cc" 按钮（不做隐藏处理）
- [ ] 单测全过（继承现有 86 个 unit/integration 基线 + 新增 ≥4 个 quick-launch 用例）
- [ ] Playwright E2E 全过（继承现有 8 个 + 新增 1 个 quick-launch happy path）
- [ ] `chore/sanitize-personal-refs` branch 在 review/merge 时与本 feature 不冲突
- [ ] 一个可 review 的 GitHub PR 提到 `Dandi007/tmux-hub`，PR 描述包含：scope、测试结果、用户机器需新增的 `templates.yaml` 配置示例、回滚说明（删 commit / 删按钮 DOM）

---

## 9. 已知风险 & 后续工作

### 9.1 风险

| 风险 | 严重度 | 缓解 |
|------|-------|------|
| 用户机器未配 `kb-cc` template，按钮 404 | 低 | toast 提示明确，README / PR 描述里说明 |
| `kb-cc` id 名字未来想改 | 低 | 已抽到 `MOBILE_QUICK_LAUNCH_TEMPLATE_ID` 常量，改一处即可 |
| 桌面端 template-drawer 多出按钮显得乱 | 极低 | 已与用户对齐：桌面端也展示这条按钮，是预期行为 |
| `cc -f` 退出后 session 立即消失，用户以为按钮失效 | 低 | 由用户在 templates.yaml 里 `cmd: "zsh -ic 'cc -f; exec zsh'"` 自决；spec 不强求 |
| 移动端按钮在用户快速重复点击下并发起多个 session | 低 | 按钮 disabled 在请求飞行期 |

### 9.2 后续工作（不在本 spec 范围）

1. 如果未来加更多 mobile-only 模板，再讨论是否引入 `surface` schema 字段。
2. 如果 `kb-cc` 之外用户想要"日志 tail"、"远程开发机 shell" 等多个 quick-launch，再讨论移动端是否需要变成"下拉/抽屉"形态。
3. 真实 CF Access JWT 验证（S3 spike）与本 feature 解耦，沿用现有 `TMUX_HUB_DEV_BIND_SECRET=1` workaround。

---

## 10. 用户机器配置示例（参考，不进 repo）

用户在 `~/.config/tmux-hub/templates.yaml` 追加：

```yaml
templates:
  - id: shell
    name: "新建 zsh"
    cwd_choices: ["~"]
    cmd: "zsh"
  - id: kb-cc                                       # 与 MOBILE_QUICK_LAUNCH_TEMPLATE_ID 对齐
    name: "知识库 cc"
    cwd_choices:
      - "~/path/to/your/knowledge-base"            # 替换成你自己的知识库目录绝对路径
    cmd: "cc -f"
```

随后 `svc restart tmux-hub`（template 列表在启动时加载）即可。

---

## 11. 交付物

1. 一个 GitHub PR 到 `Dandi007/tmux-hub`，源分支 `feat/mobile-quick-launch`，目标 `main`。
2. PR 描述包含：scope（本 spec §3）、测试结果、用户机器配置示例（§10）、回滚说明。
3. 本 spec + 实现计划（`docs/superpowers/plans/2026-05-23-mobile-quick-launch-plan.md`，由 `writing-plans` skill 产出）+ 完整实现 commits + 测试，全部在同一个 feat branch 上。
