# Design: Seamless Chrome / PWA Support for tmux-hub

- **Date**: 2026-05-22
- **Issue**: https://github.com/Dandi007/tmux-hub/issues/1
- **Author**: [@Dandi007](https://github.com/Dandi007)
- **Status**: Approved

## 1. Goal (第一性原理)

让 tmux-hub 在 Chrome / Edge / Brave 里可被"安装"为 PWA：从 Dock 启动到独立窗口，右键有 shortcuts，离线或 Cloudflare Access cookie 失效时壳秒开而不是白屏。其他形态（Electron / Tauri / Chrome Extension / iOS 原生壳）显式不在范围内。

不解决的问题：终端业务本身的离线模拟（终端必须联网才能跑 shell，这是物理约束）。

## 2. Phase split

| Phase | 内容 | 状态 |
|---|---|---|
| Phase 1 | Installable + Service Worker 壳离线 + Manifest shortcuts | 本 spec 覆盖 |
| Phase 2+ | Push / file_handlers / launch_handler / protocol_handlers / Background Sync / WCO 真正绘制 tabs | follow-up checklist，不展开 |

## 3. Phase 1 架构

### 3.1 文件落点

```
src/web/
├── index.html               # 顶部加 <link rel="manifest" href="/manifest.webmanifest">
├── manifest.webmanifest     # (新) PWA manifest
├── sw.ts                    # (新) Service Worker - app shell cache only
├── pwa/
│   ├── register-sw.ts       # (新) SW 注册 + update prompt
│   └── install-prompt.ts    # (新) beforeinstallprompt 处理
└── assets/icons/            # (新) 192 / 512 / maskable-512 PNG
```

服务端 `src/server/main.ts` 仅一处变动：`sw.js` 路由必须返回 `Service-Worker-Allowed: /` 和 `Cache-Control: no-cache`，否则 SW 自己被旧版本困死。

### 3.2 Cloudflare Access × Service Worker 策略（关键决策）

风险：CF Access 用 cookie 鉴权，未登录请求 302 到 Google OAuth。SW 若拦截所有 fetch，会把 redirect HTML 缓存进去，PWA 装死。

策略：**SW scope 严格限定到 app shell**，API/WS 完全 pass-through 或不拦截。

| 资源 | SW 策略 |
|---|---|
| `/`、`/index.html`、`/*.js`、`/*.css`、`/assets/icons/*` | cache-first（首次访问 CF Access 已通过后才会被 cache） |
| `/ws/sessions/*`（WebSocket） | 完全不拦截 |
| `/api/*`、`/templates`、`/events`、`/sessions/*` | network-only pass-through，**永不入 cache** |
| `opaqueredirect` / 3xx 响应 | **永不写 cache** |

未登录 CF Access 时的预期行为：
1. PWA 壳秒开（cache hit）
2. JS 启动后第一个 API 调用 401 → 客户端显示"请重新登录"覆盖层 → 跳 `/`，CF Access 接管 redirect 链
3. 重新登录回来后，SW 已 cache 的壳保持有效，无需重下载

### 3.3 Manifest 内容

```json
{
  "name": "tmux-hub",
  "short_name": "tmux-hub",
  "id": "/?source=pwa",
  "start_url": "/?source=pwa",
  "scope": "/",
  "display": "standalone",
  "display_override": ["window-controls-overlay", "standalone"],
  "background_color": "#1a1a1f",
  "theme_color": "#1a1a1f",
  "icons": [
    { "src": "/assets/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/assets/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/assets/icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "shortcuts": [
    { "name": "新会话 (zsh)", "url": "/?action=new-session" },
    { "name": "会话列表", "url": "/?focus=session-list" }
  ]
}
```

`display_override: window-controls-overlay` 让标题栏融合到 app（桌面 Chrome 支持的最接近原生的形态）。Phase 1 只 opt-in，真正把 tabs 画到标题栏放 Phase 2。

`?source=pwa` 和 `?action=new-session` / `?focus=session-list` 由现有 SPA 路由处理（启动时读 query）。

Icon 设计：`T` 字母或会话格子主题，配现有暗色 `#1a1a1f` + 灰底。**Phase 1 不锁死设计稿**，实施时再定。

### 3.4 平台覆盖

| 平台 | Phase 1 |
|---|---|
| Chrome / Edge / Brave Desktop (macOS / Linux / Windows) | ✅ 主目标 |
| Android Chrome | ✅ 顺路覆盖，需 maskable icon |
| iOS Safari "Add to Home Screen" | ⚠️ 不专门优化，**但不破坏** |

## 4. Acceptance Criteria

- [ ] Chrome 桌面在 `https://<your-deployment-host>` 地址栏出现"安装 tmux-hub"按钮
- [ ] 安装后 Dock 出现图标，点击在独立窗口启动（无 tab / address bar）
- [ ] 离线状态打开 PWA：壳能加载，看到"未连接 hub"占位（不是白屏）
- [ ] CF Access cookie 过期：壳秒开 → ~1s 内出现重登提示 → 重登后无需重下载壳
- [ ] 右键 Dock 图标看到 2 条 shortcuts，点击落到对应入口
- [ ] Lighthouse PWA score ≥ 90
- [ ] Android Chrome 可装可启动，无功能 regression
- [ ] 既有 E2E 全绿；新增测试：SW 注册成功、manifest 可访问、壳能在 401 下存活

## 5. Risks / 已知坑

- **SW × CF Access 首次登录引导**：自动化测试只能覆盖到 cookie 还在的场景；CF Access redirect 链需要手测一轮
- **xterm.js bundle 体积**：缓存的 app shell 可能很快超过 3 MB，需在实施时实测
- **Maskable icon 设计**：图标不是工程问题，需要单独排时间产出设计稿

## 6. Phase 2+ Follow-ups（不在本 spec 范围）

- Push 通知（build 完成 / session crash）
- `file_handlers`：拖 `.sh` 到 PWA 窗口运行
- `launch_handler: focus-existing`：从他处再次打开 tmux-hub 聚焦已有窗口
- `protocol_handlers`：`tmuxhub://<session>` deep-link
- Background Sync：窗口后台时的 WS 重连重试
- Window Controls Overlay：真正把 session tabs 绘制到标题栏带

# References

- GitHub issue：https://github.com/Dandi007/tmux-hub/issues/1
- 实施 plan：[`../plans/2026-05-22-pwa-chrome-app.md`](../plans/2026-05-22-pwa-chrome-app.md)
