# Mobile Visibility Recovery Design

**Date:** 2026-05-23
**Branch:** `feat/mobile-visibility-recovery`
**Worktree:** `/Volumes/Data/code/worktrees/tmux-hub/feat-mobile-visibility-recovery/`

## §1 第一性原理：要什么

页面从后台切回前台（移动端尤其是 iOS PWA / Safari）并且离开时长足够长时，**当前 session 必须自动恢复到能正常收发数据的状态**，无需任何人工操作。

**判定"该恢复"的标准**：页面隐藏时长 ≥ **3 秒**——足够覆盖被 OS 真正挂起的场景，又能跳过 Cmd+Tab / 查看通知 / 接电话这种瞬时切换。

**等价行为**：用户当前可以通过"在 session 选择框切到另一个 session 再切回来"恢复（mobile）或重新点击 session 列表项恢复（desktop）。本特性让这一动作在 visibility 边沿自动发生。

**非目标**：
- 不实现"in-place WS 重连"（保留 xterm 不销毁）——之前已验证这种路径与 xterm renderer / server ring buffer / 光标位置容易错位
- 不引入服务端协议变更
- 不主动 ping / keepalive；只在 visibility 边沿触发

## §2 现状与症状根因

| 子系统 | 现状 | 后台恢复行为 |
|--------|------|------------|
| SSE (`sse-client.ts`) | 单条 `EventSource` 推送 session 列表 / 活动事件，`onerror` 后 1s 自动重连 | iOS Safari 经常出现 ES `readyState === OPEN` 但实际收不到任何 event 的"假活"状态，`onerror` 永远不触发 |
| WebSocket (`terminal.ts`) | 每个 attach 一条独立 WS，**没有任何重连逻辑** | 后台被 OS 挂起后回前台，WS 已 CLOSED，xterm 仍停留在离开时的画面，并显示 `[hub] connection closed` |
| Mobile 切换 session (`mobile-view.ts:80-87`) | `openSession(name)` → tear-down + 重建 attach；并发请求通过 `pendingTarget` + serial transition queue 串行化 | 切到不同 session 触发完整 re-attach，恢复正常；同名 session 会被 `if (target === openedName && term) continue;`（mobile-view.ts:43）跳过 |
| Desktop 切换 session (`desktop-view.ts:29-78`) | `open(name)` → 无条件 tear-down + 重建；无 same-target skip | 重新点击当前 session 项即可恢复 |

**根因**：visibility 事件没有任何 handler，WS / SSE 在被 OS 挂起后没有任何主动恢复机制。

## §3 方案

新增一个共享的 visibility 状态机模块；mobile / desktop 各自注册回调，回调里做"完整 re-attach 当前 session" + "SSE 主动重连"。

### 3.1 新增模块 `src/web/visibility-recovery.ts`

```ts
export type ForegroundRecoverCancel = () => void;

export function onForegroundAfterIdle(
  thresholdMs: number,
  cb: () => void,
): ForegroundRecoverCancel;
```

**内部状态机（模块级单例）**：

| 字段 | 含义 |
|------|------|
| `hiddenAt: number \| null` | 进入 hidden 的时间戳；visible 时为 null |
| `subs: Map<id, { thresholdMs, cb }>` | 所有订阅者 |
| `listenersAttached: boolean` | 是否已注册全局 listener（懒注册） |

**事件源**：
- `document.addEventListener('visibilitychange', onChange)`
- `window.addEventListener('pageshow', onPageShow)`——`event.persisted === true`（iOS bfcache 恢复）视同 `idleMs = Infinity`

**触发逻辑**：
- `visibilitychange`：
  - `document.visibilityState === 'hidden'` → 记录 `hiddenAt = Date.now()`
  - `=== 'visible'` 且 `hiddenAt != null`：计算 `idleMs = Date.now() - hiddenAt`，遍历 subs 触发 `idleMs >= thresholdMs` 的 cb；最后 `hiddenAt = null`
  - `=== 'visible'` 且 `hiddenAt === null`：no-op（防止 OS 抽风派多次 visible）
- `pageshow` 且 `event.persisted === true`：所有 sub 都触发（视同 `idleMs = Infinity`，不看 threshold），**触发后立即清 `hiddenAt = null`**——防止紧随其后的 `visibilitychange → visible` 再触发一次

**懒注册 / 自动卸载**：
- 第一次 `onForegroundAfterIdle` 调用时注册全局 listener
- 返回的 cancel 从 subs 中删除该订阅；subs 为空时 detach 全局 listener 并清 `hiddenAt`

**为什么是模块单例**：mobile / desktop / SSE 三个 callback 共享同一份 hiddenAt 状态判定，避免漂移；每次 visibility event 只派发一遍。

### 3.2 `sse-client.ts` 改造

API 从单个 dispose 函数改成对象：

```ts
export type SseHandle = {
  stop: () => void;
  reconnect: () => void;
};

export function subscribeEvents(onEvent: (e: ServerEvent) => void): SseHandle;
```

**`reconnect()` 语义**：
1. 取消任何 pending 的 `setTimeout(connect, 1000)`（onerror 调度的）——把 `retryTimer: ReturnType<typeof setTimeout> | null` 提到 closure 顶层
2. close 当前 ES（如果有）
3. 立刻 `connect()` 建新 ES

**幂等保证**：连续两次 `reconnect()` 无副作用——`clearTimeout(null)` 安全，`close()` 在已关闭 ES 上安全，第二次 `connect()` 会替换上一个 ES。

**与 onerror retry 协同**：onerror 的 `setTimeout(connect, 1000)` 仍保留，只是 reconnect() 会先 clear 它。不会出现"reconnect 建好新 ES + 1s 后 onerror 调度的 setTimeout 又 connect 一遍"的双连。

### 3.3 `mobile/mobile-view.ts` 改造

**① `openSession` 加 `{ force?: boolean }` 选项**：

```ts
type PendingTarget = { name: string; force: boolean } | null;
let pendingTarget: PendingTarget = null;

const openSession = (name: string, opts?: { force?: boolean }): void => {
  // force=true 覆盖 force=false（重连优先级高）
  const force = (opts?.force ?? false) || (pendingTarget?.force ?? false);
  pendingTarget = { name, force };
  if (!runningTransition) {
    runningTransition = runTransitions().finally(() => { runningTransition = null; });
  }
};

// runTransitions 取出 target 时改成：
const { name: target, force } = pendingTarget;
pendingTarget = null;
if (!force && target === openedName && term) continue;  // force=true 跳过同名 skip
```

**② SSE handle 改成捕获返回值**：

```ts
const sse = subscribeEvents((e: ServerEvent) => { /* 现有 handler */ });
```

**③ 注册 visibility recover callback**：

```ts
onForegroundAfterIdle(3000, () => {
  sse.reconnect();
  if (openedName !== null) openSession(openedName, { force: true });
});
```

**④ 现有 `window.__tmuxHub` 注入处不变**。`onForegroundAfterIdle` 返回的 cancel 暂不接入 teardown——mobile-view 没有显式 teardown 钩子，进程级生命周期；丢弃返回值即可。

### 3.4 `desktop/desktop-view.ts` 改造

**① 跟踪 activeName**：

```ts
let activeName: string | null = null;

const open = async (name: string) => {
  if (term) { term.close(); term = null; }
  list.setActive(name);
  // ... 现有逻辑 ...
  try {
    term = await attachTerminal({ sessionName: name, parent: host });
    activeName = name;  // 仅在 attach 成功后置
  } catch (e) { /* ... */ }
};
```

**② 注册 visibility recover callback**：

```ts
onForegroundAfterIdle(3000, () => {
  if (activeName !== null) void open(activeName);
});
```

注意：desktop 的 `open` 没有 serial queue，但因为它每次都先无条件 `term.close()` 再 attach，且第二次 recover 调用进来时 `term` 指向的是上次 attach 出来的新 term（即将被关掉），不会形成长期残留。最坏情况是用户在 recover 进行中又点了一下列表，那是用户行为，行为正确。

### 3.5 `desktop/session-list.ts` 改造

**SSE handle 改成捕获返回值并注册 visibility callback**：

```ts
const sse = subscribeEvents(apply);
onForegroundAfterIdle(3000, () => sse.reconnect());
```

替换原 `const unsub = subscribeEvents(apply);`（保留 unsub 等价物 `sse.stop`）。

## §4 边界情况

| 场景 | 行为 |
|------|------|
| 隐藏 1s 后可见 → 立刻又隐藏 → 5s 后可见 | 第一次未达阈值不触发；第二次达阈值正常触发 |
| OS 派发多次 visible（不经 hidden 中间态） | `hiddenAt === null` 时跳过，no-op |
| recover 触发时 `openedName === null` / `activeName === null` | callback 直接 return |
| recover 触发时 `runningTransition` 还在跑（mobile） | `openSession(openedName, { force: true })` 入队 pendingTarget，由 runTransitions 自然消化 |
| recover 期间用户手动切了 session（mobile） | 后到的 user pick 会通过 OR 合并保留 force=true；继续走 re-attach |
| Hidden 期间 session 被服务端删除 | attachTerminal → ws.onerror → 已有 catch + toast 路径处理（mobile-view.ts:62-68 / desktop-view.ts:49-52）|
| `pageshow persisted=true` 后紧跟 `visibilitychange → visible` | pageshow handler 触发完所有 sub 后立即 `hiddenAt = null`；随后的 visible 看到 `hiddenAt === null` 自动跳过 |
| 阈值内的 visibility flap（hidden ↔ visible 多次） | 只有最近一次 visible 时按 hiddenAt 计算 idleMs；状态机线性，无累计 |
| 多个订阅者注册同一阈值 | 各自独立判定 + 调用，顺序按注册顺序 |
| SSE reconnect 与 onerror retry 撞车 | reconnect 进入时 clearTimeout(retryTimer)，不会双连 |

## §5 测试策略

### 5.1 单元（vitest）

**`tests/visibility-recovery.test.ts`**（新增 ~80 行）：
- mock `document.visibilityState` + `dispatchEvent('visibilitychange')`，断言阈值上下分支
- mock `window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))`，断言无视阈值触发
- 多订阅者：注册 2 个，分别阈值 1000 / 5000，hidden 3s 后 visible，只有 1000 的触发
- cancel：取消后 callback 不再触发；最后一个 cancel 后全局 listener 应被卸载（通过 spy on removeEventListener 验证）

**`tests/sse-client.test.ts`**（新增 ~40 行）：
- mock `EventSource`（封装一个 FakeEventSource 类）
- 验证 `reconnect()` 调用：先 clearTimeout pending retry → close 旧 ES → 立刻 new EventSource
- 验证幂等性：连续两次 reconnect 不抛、不留垃圾 ES
- 验证 onerror 仍正常工作（reconnect 不应破坏现有路径）

### 5.2 集成（vitest + jsdom）

mobile-view 注入 mock attachTerminal，模拟 visibilitychange，断言 attachTerminal 第二次被调用时 sessionName 仍是当前 openedName（验证 force 旁路同名 skip）。

### 5.3 E2E（playwright）

新增 `tests/e2e/mobile-visibility.spec.ts`：
1. 以 mobile viewport 启动 hub
2. attach 任一可见 session
3. `page.evaluate` 模拟 hidden（`Object.defineProperty(document, 'visibilityState', ...)` + dispatchEvent）
4. 真实 `await page.waitForTimeout(4000)`（阈值 3s + 余量）
5. dispatchEvent visible
6. 断言新 WS 建连（通过 console.log 标记或 `page.on('console')` 抓 `[tmux-hub] tui-cursor-gate-v10 attaching to <name>` 出现第 2 次）

### 5.4 手测（最有信号）

1. PC 浏览器开 mobile viewport（DevTools device toolbar），attach 跑着 `watch -n1 date` 的 session
2. 切到另一 app / 锁屏 30 秒
3. 回到浏览器，应能看到时间继续滚动而不是停在离开那一刻
4. 真机 iOS PWA 重复一次：safari → 桌面 → 等 30s → 重新打开 PWA → 时间应继续

## §6 文件改动清单

| 文件 | 性质 | 估行 |
|------|------|------|
| `src/web/visibility-recovery.ts` | 新增 | ~60 |
| `src/web/sse-client.ts` | 改 return 类型 + 加 reconnect | +15 |
| `src/web/mobile/mobile-view.ts` | openSession 加 force + 注册订阅 | +15 |
| `src/web/desktop/desktop-view.ts` | activeName 跟踪 + 注册订阅 | +10 |
| `src/web/desktop/session-list.ts` | SSE handle 改 + 注册订阅 | +5 |
| `tests/visibility-recovery.test.ts` | 新增 | ~80 |
| `tests/sse-client.test.ts` | 新增 | ~40 |
| `tests/e2e/mobile-visibility.spec.ts` | 新增（可选，手测优先） | ~50 |

## §7 实施顺序建议

1. `visibility-recovery.ts` 模块 + 单测（独立模块，可先 RED→GREEN）
2. `sse-client.ts` 改 + 单测
3. `mobile-view.ts` wire（hand-test 移动端可见 / 隐藏切换）
4. `desktop-view.ts` + `session-list.ts` wire（hand-test desktop）
5. 整体手测（PC mobile viewport + 真机 iOS PWA）
6. E2E（如果手测信号充分可省略）

## §8 风险与已知未知

- iOS PWA 在被系统真正杀掉后，整个 JS 上下文都没了——本特性恢复不了已死的 JS 进程，只能恢复进程还活着但 WS/SSE 被网络层挂掉的场景。后者覆盖率应该已经能拿掉用户当前抱怨的 80%+
- `pageshow persisted=true` 在现代 Safari 下不一定每次都派发；不要把它当成兜底，主路径还是 visibilitychange + 3s 阈值
- 服务端 ring buffer 在 quick-launch / mobile-fixes-r2 已经验证过 re-attach 回放正确，本特性不动服务端，沿用即可
