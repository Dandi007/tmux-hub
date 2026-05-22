# Plan: PWA / Installable Chrome App (Phase 1)

- **Date**: 2026-05-22
- **Spec**: [`../specs/2026-05-22-pwa-chrome-app-design.md`](../specs/2026-05-22-pwa-chrome-app-design.md)
- **Issue**: https://github.com/Dandi007/tmux-hub/issues/1
- **Scope**: Phase 1 only — Installable + SW 壳离线 + Manifest shortcuts
- **Estimated effort**: 3–5 days

## 执行原则

- 每个 task 走 TDD（RED → GREEN → REFACTOR），允许偏离的地方在 task 内显式说明（如 SW lifecycle 仅手测）
- 每个 task 完成 → 至少跑通既有 `bun test`、`pnpm vite build`、`pnpm playwright test`，不引入 regression
- task 之间尽量保证可中断（中途停下 main 仍可用）
- 实施时优先在 worktree 分支开发：`$AGENT_CODE_ROOT/worktrees/tmux-hub/pwa-phase-1`

## Task 依赖图

```
T1 (manifest + icons) ──┐
                        ├─→ T4 (install prompt)  ──┐
T2 (service worker) ────┤                          │
                        ├─→ T5 (shortcuts wiring) ─┼─→ T6 (audit + tests)
T3 (sw registration) ───┘                          │
                                                   ┘
```

---

## Task 1 — Manifest + icon scaffold

**目标**：浏览器识别站点为可安装 PWA，地址栏出现"安装"按钮，**不动 SW**。

**文件**：
- `src/web/manifest.webmanifest`（新）
- `src/web/index.html`（编辑：head 加 `<link rel="manifest" ...>` + `<meta name="theme-color">`）
- `src/web/assets/icons/icon-192.png`、`icon-512.png`、`icon-maskable-512.png`（新；先用占位纯色）
- `vite.config.ts`（如需复制 manifest / icons 到 dist）
- `src/server/main.ts`（静态文件已通过通配路径返回，无需新增路由；如有 MIME 问题再处理）

**TDD**：
- RED：新增 Playwright 测试 `tests/e2e/pwa.spec.ts` → `await page.goto('/'); const m = await page.request.get('/manifest.webmanifest'); expect(m.status()).toBe(200);` 失败
- GREEN：写 manifest + icon + link tag，测试通过
- REFACTOR：icon 文件用 git-lfs 或留到 task 6 替换正式素材

**Acceptance**：
- [ ] `bun run dev` 后 Chrome devtools → Application → Manifest 显示无 error
- [ ] `/manifest.webmanifest` HTTP 200，`content-type` 含 `manifest+json`
- [ ] Chrome 地址栏显示"安装 tmux-hub"按钮（**首次** acceptance）

**Estimated**: 0.5 day

---

## Task 2 — Service Worker (app-shell cache)

**目标**：实现 `sw.ts`，按 spec §3.2 策略 cache 壳、放行 API/WS、不缓存 redirect。

**文件**：
- `src/web/sw.ts`（新）
- `vite.config.ts`（新增 `rollupOptions.input.sw`，输出独立 `sw.js`，**不打到 main bundle**）
- `src/server/main.ts`（编辑：`sw.js` 路径返回 `Service-Worker-Allowed: /` + `Cache-Control: no-cache`；目前静态文件由通配路径处理，需为 `sw.js` 单独加一条命中分支）

**TDD**：
- RED：单元测试 `tests/unit/sw.spec.ts` 用 `@miniflare/service-worker` 或 simple jest-fetch-mock；断言：
  - GET `/api/templates` 不进 cache
  - GET `/index.html` 进 cache、二次访问 cache-first
  - opaqueredirect 不进 cache
- GREEN：实现 SW，逻辑挂 `install` / `fetch` / `activate` 三个 listener
- REFACTOR：cache key 加版本号（`tmux-hub-shell-v1`），方便后续滚动失效

**Acceptance**：
- [ ] 单元测试全绿
- [ ] devtools → Application → Service Workers 显示 `sw.js` 已 activate
- [ ] devtools → Network 离线模式刷新页面，HTML/JS/CSS 命中 SW、API 调用失败但壳渲染
- [ ] 故意把 `/api/templates` mock 成 401，刷新后壳能加载，控制台看到 401 不被 cache

**Estimated**: 1 day

**风险**：SW lifecycle 在 dev server (Vite HMR) 下行为诡异；建议本任务**只在 `bun run build && bun run preview`** 下手测，不在 dev 模式调试。

---

## Task 3 — SW registration + update prompt

**目标**：在 SPA 启动时注册 SW，提供 update 提示。

**文件**：
- `src/web/pwa/register-sw.ts`（新）
- `src/web/main.ts`（编辑：调用 `registerSw()`，仅 `import.meta.env.PROD` 下）
- 共享 toast 组件：复用 Task 14.5 完成的 toast primitive 显示"新版本可用，刷新生效"

**TDD**：
- RED：单元测试 `register-sw.spec.ts` 断言 `navigator.serviceWorker.register` 被调用、`updatefound` 事件触发 toast
- GREEN：实现注册逻辑、监听 `controllerchange` / `updatefound`
- REFACTOR：抽出常量 `SW_URL`、`SW_SCOPE`

**Acceptance**：
- [ ] 单元测试全绿
- [ ] 改一个 cache version 后 `bun run build` + 刷新 → toast 出现"刷新生效"

**Estimated**: 0.5 day

---

## Task 4 — Install prompt UX

**目标**：监听 `beforeinstallprompt`，在 sidebar 或 toolbar 提供"安装到桌面"入口，已安装状态下隐藏。

**文件**：
- `src/web/pwa/install-prompt.ts`（新）
- `src/web/desktop/sidebar.ts` 或对应入口（编辑：插入"安装应用"按钮）
- `src/web/style.css`（编辑：按钮 styling）

**TDD**：
- RED：Playwright 测试触发 `window.dispatchEvent(new Event('beforeinstallprompt'))` 后断言按钮可见；触发 `appinstalled` 后断言按钮消失
- GREEN：实现 listener + DOM 切换
- REFACTOR：抽出 `useInstallPrompt()` 工厂便于未来 mobile 复用

**Acceptance**：
- [ ] Playwright 测试全绿
- [ ] 手测：未安装时桌面端 sidebar 显示按钮、点击触发安装对话框；已安装后按钮自动隐藏

**Estimated**: 0.5 day

---

## Task 5 — Manifest shortcuts wiring

**目标**：让 `?action=new-session` 和 `?focus=session-list` 在 SPA 启动时被处理，对应到既有的"新建 zsh"和"聚焦会话列表"行为。

**文件**：
- `src/web/main.ts` 或路由初始化处（编辑：读 `URLSearchParams`，dispatch 对应 action）
- `src/web/desktop/session-list.ts`（编辑：暴露 `focusSessionList()` 给 main.ts）
- `src/web/desktop/template-drawer.ts`（编辑：暴露 `triggerNewSession()` 给 main.ts）

**TDD**：
- RED：Playwright 测试 goto `/?action=new-session` → 断言 200ms 内调用 `POST /templates/<id>/run`（mock 后端）
- GREEN：实现 query 处理
- REFACTOR：把 query 处理抽到 `src/web/pwa/shortcuts.ts`

**Acceptance**：
- [ ] Playwright 测试全绿
- [ ] 手测：安装后右键 Dock 图标 → 点击"新会话 (zsh)"→ 独立窗口启动后立刻创建新 session
- [ ] 手测：右键 → "会话列表" → 独立窗口启动后会话列表得到焦点

**Estimated**: 0.5 day

---

## Task 6 — Audit + cross-platform smoke + final polish

**目标**：把图标素材替换成正式设计稿，跑 Lighthouse PWA 审计，Android Chrome 手测，整理 changelog。

**文件**：
- `src/web/assets/icons/*.png`（替换为正式素材）
- `README.md`（编辑：加 "Installable PWA" 段落）
- `CHANGELOG.md`（新增 `### PWA support` 段）

**TDD**：
- RED：在 CI 中加 Lighthouse PWA 评分 ≥ 90 的 gate（用 `treosh/lighthouse-ci-action` 或 `lhci`）
- GREEN：补缺失的 manifest 字段直到达到 90 分
- REFACTOR：把审计脚本固化到 `package.json` 的 `lighthouse:pwa` script

**Acceptance**：
- [ ] Lighthouse PWA score ≥ 90 in CI
- [ ] Android Chrome（实机或模拟器）能装、能启动、无功能 regression
- [ ] README 有安装说明
- [ ] CHANGELOG 有条目
- [ ] 既有所有 E2E 全绿

**Estimated**: 1 day

---

## 完成定义（Phase 1 done）

所有 6 个 task 的 Acceptance 全部勾选 + spec §4 所有 Acceptance Criteria 全部勾选 → 提 PR → 合并到 main → 部署到 `tui.qinglinzhang.xyz` → 手动在 macOS Chrome 实测一次完整流程（装 → 用 → 重登 → 卸载）。

# References

- Spec：[`../specs/2026-05-22-pwa-chrome-app-design.md`](../specs/2026-05-22-pwa-chrome-app-design.md)
- GitHub issue：https://github.com/Dandi007/tmux-hub/issues/1
- Phase 2+ 见 spec §6
