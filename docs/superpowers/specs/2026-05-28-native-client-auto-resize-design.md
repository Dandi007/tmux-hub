# Native tmux Client Auto-Resize

## 第一性原理

tmux-hub 服务 web/mobile client 和原生 terminal client 两类用户。两类 client 对 window-size 的需求相反：

- **Web/mobile**：viewport 由前端精确控制，必须 pin 到 WS 上送的 `cols×rows`，不能被其他 client attach 抢走。
- **原生 terminal**：希望 `tmux a` 后 window 自动 fit 到终端实际大小，SIGWINCH 时跟着 resize。

`pinViewport()` 为了满足前者，每次 WS 连接都把 session 的 `window-size` 设成 `manual` 并强制 resize 到指定尺寸。代价是原生 client attach 时不再自动 resize——window 卡在最后一次 web pin 的尺寸（例如 199×52），原生终端如果是 214×44，右侧多出来 15 列就是 tmux 渲染不到的"点阵区"。

要让两类 client 都满意：保留 manual 模式（web 端继续受益），同时给原生 client 在 attach / SIGWINCH 时显式触发一次 fit。

## 方案

`window-size manual` 不影响 `resize-window -A` 的手动调用——`-A` 会按当前 client 的实际尺寸 fit window。所以只需要两条 global hook：

```
client-attached → resize-window -A
client-resized  → resize-window -A
```

Hook 只对真实 tmux client（terminal `tmux a`）触发。WebSocket client 不是 tmux client，不会触发，所以不影响 `pinViewport` 的精确控制。

## 改动清单

| File | Change |
|------|--------|
| `src/server/tmux-bootstrap.ts` | 新增。`bootstrapTmuxHooks(runner)` 安装两条 global hook |
| `src/server/main.ts` | `await registry.start()` 后调用 `bootstrapTmuxHooks()` |
| `src/server/session-control.ts` | `POST /system/start-tmux-server` 成功后调用 `bootstrapTmuxHooks()`，覆盖手动重启场景 |
| `tests/integration/tmux-bootstrap.test.ts` | 新增。验证 hook 已安装、多次调用幂等 |

## 测试计划

- Integration: 两条 hook 都存在 + 同名 hook 不堆叠（`bootstrapTmuxHooks` 多次调用幂等）
- 全量回归：`bun test tests/unit tests/integration` 全绿
- 手验：本机 `tmux resize-window -A` 验证 window 从 199×52 fit 到 214×43，与终端匹配

## 非目标

- 不引入 `.tmux.conf`——hook 由 tmux-hub 在进程启动时注入，避免依赖外部配置
- 不改 `window-size manual` 默认值——保留 web/mobile 精确控制语义
