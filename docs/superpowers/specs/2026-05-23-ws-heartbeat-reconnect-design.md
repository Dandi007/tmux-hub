# WebSocket 心跳 + 传输层自动重连设计

**Date:** 2026-05-23
**Branch:** `feat/ws-heartbeat-reconnect`
**Worktree:** `/Volumes/Data/code/worktrees/tmux-hub/feat-ws-heartbeat-reconnect/`
**Supersedes:** `2026-05-23-mobile-visibility-recovery-design.md` §3.3 ③ / §3.4 ② 中的 visibility-based reconnect

## §1 第一性原理：要什么

WebSocket 断线后（iOS 后台冻结、弱网、WiFi 切蜂窝、服务端重启），**终端必须自动恢复到能正常收发数据的状态**，无需任何人工操作。

**核心约束**：
- 断线检测必须在传输层完成，不依赖 UI 层的 visibility 事件
- 重连决策由实际连接健康状态驱动，不依赖启发式猜测
- 重连过程对用户透明——看到短暂的状态提示后画面自动恢复

**非目标**：
- 不做整个 terminal 实例的销毁重建——重连时保留 xterm 实例（DOM + addons），只替换底层 WS 连接
- 不改变服务端 replay 协议——现有 RIS + ring buffer + attachWithReplay 已验证可靠

## §2 现状与根因

### 2.1 现有 visibility-recovery 方案的缺陷

当前方案（`visibility-recovery.ts`）在页面从后台回前台时检查 `term.isConnected`（即 `ws.readyState === WebSocket.OPEN`）来判断是否需要重连。

**根因**：这是一个时序竞态。

```
事件顺序（iOS Safari PWA 实测）：
1. 页面冻结（iOS 挂起 JS 执行）
2. TCP 连接超时断开（OS 层面，JS 不知道）
3. 用户切回 PWA
4. visibilitychange → "visible" 触发
5. onForegroundAfterIdle 回调执行
   → ws.readyState 此刻仍是 OPEN（浏览器尚未感知 TCP 已死）
   → isConnected 返回 true → 跳过重连
6. 浏览器事件循环恢复后，WS 发现底层 TCP 已死
   → 触发 ws.onerror → "[hub] connection error"
   → 触发 ws.onclose → "[hub] connection closed"
7. 此时 isConnected 变 false，但 onForegroundAfterIdle 已执行完
```

**结论**：`readyState` 不可信。需要应用层心跳来实时探测连接活性。

### 2.2 问题汇总

| # | 问题 | 严重度 |
|---|---|---|
| 1 | WS `readyState` 在 iOS 冻结后仍为 OPEN，`isConnected` 误判 | CRITICAL |
| 2 | Desktop view 没有 SSE reconnect（SSE handle 在 session-list 内部，desktop-view 未持有） | HIGH |
| 3 | 所有断线检测依赖 visibility 事件——弱网、WiFi 切蜂窝、服务端重启等不经过 visibility 变化的断线场景无法覆盖 | HIGH |

## §3 方案概述

```
┌─────────────────────────────────────────────────────────────────┐
│                        terminal.ts                              │
│                                                                 │
│  ┌──────────┐    ping     ┌──────────┐    pong     ┌─────────┐ │
│  │ Heartbeat├────────────►│ WebSocket├────────────►│ Checker │ │
│  │  Timer   │  {kind:ping}│          │  {kind:pong}│  Timer  │ │
│  └──────────┘             └──────────┘             └─────────┘ │
│       │                        │                        │       │
│       │                        │ close/error            │ timeout│
│       ▼                        ▼                        ▼       │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │               Reconnect State Machine                    │   │
│  │  connected ──► reconnecting ──► connected                │   │
│  │                    │                                     │   │
│  │                    └──► (max retries) ──► dead           │   │
│  └──────────────────────────────────────────────────────────┘   │
│       │                                                         │
│       │ onStateChange(state)                                    │
│       ▼                                                         │
│  ┌──────────┐                                                   │
│  │ View层回调│  → 显示状态条 / 清理                              │
│  └──────────┘                                                   │
└─────────────────────────────────────────────────────────────────┘
```

### 3.1 职责重新分配

| 层 | 旧职责 | 新职责 |
|---|---|---|
| `visibility-recovery.ts` | 检测 idle + 判断是否重连 + 触发重连 | 仅用于 SSE reconnect + 回前台时立即触发一次心跳探测（加速发现） |
| `terminal.ts` | 无重连能力 | 心跳发送 + 超时检测 + 自动重连 + 状态回调 |
| `mobile-view.ts` / `desktop-view.ts` | 持有 visibility 回调做 WS 重连 | 监听 terminal `onStateChange` 显示状态 UI；不再直接操心 WS 重连 |

## §4 协议变更

### 4.1 新增消息类型

```typescript
// shared/protocol.ts

export type ClientWsMessage =
  | { kind: "keys"; literal: string }
  | { kind: "key"; name: string }
  | { kind: "resize"; cols: number; rows: number }
  | { kind: "ping"; ts: number };           // 新增

export type ServerWsMessage =
  | { kind: "pong"; ts: number };            // 新增
```

`ts` 字段是客户端发送时的 `Date.now()` 时间戳，服务端原样回传。客户端可用此计算 RTT。

### 4.2 服务端处理

```typescript
// server/main.ts websocket.message handler 新增分支

if (parsed.kind === "ping") {
  try { ws.send(JSON.stringify({ kind: "pong", ts: parsed.ts })); } catch {}
  return;
}
```

- Ping/pong 不经过 `input.send()`，不触发 tmux session 交互
- Pong 回复是 JSON 文本帧，与现有 binary 数据帧共存（客户端 `onmessage` 已有 string vs ArrayBuffer 分流）

## §5 客户端心跳与重连状态机

### 5.1 `attachTerminal` 返回类型扩展

```typescript
export type TerminalState = "connected" | "reconnecting" | "dead";

export type TerminalHandle = {
  el: HTMLElement;
  send: (msg: ClientWsMessage) => void;
  close: () => void;
  probeNow: () => void;
  readonly isConnected: boolean;
  readonly state: TerminalState;
  onStateChange: (cb: (state: TerminalState) => void) => void;
};
```

### 5.2 常量

```typescript
const HEARTBEAT_INTERVAL_MS = 15_000;   // 每 15s 发一次 ping
const HEARTBEAT_TIMEOUT_MS  = 5_000;    // 5s 内没收到 pong → 判定断线
const RECONNECT_MAX_RETRIES = 8;        // 最多重试 8 次
const RECONNECT_BASE_MS     = 500;      // 初始退避 500ms
const RECONNECT_MAX_MS      = 30_000;   // 最大退避 30s
const RECONNECT_JITTER      = 0.3;      // ±30% 随机抖动
```

### 5.3 心跳逻辑

```
每 HEARTBEAT_INTERVAL_MS:
  1. 发送 { kind: "ping", ts: Date.now() }
  2. 启动 pong 等待计时器（HEARTBEAT_TIMEOUT_MS）

收到 { kind: "pong", ts }:
  1. 取消 pong 等待计时器
  2. 可选：记录 RTT = Date.now() - ts

pong 等待超时:
  1. 判定连接已死
  2. 进入 reconnecting 状态
```

### 5.4 重连状态机

```
          ┌────────── connected ◄──────────┐
          │               │                │
          │      heartbeat timeout /       │
          │      ws.onclose / ws.onerror   │
          ▼                                │
     reconnecting ─────────────────────────┘
          │           成功 attach
          │
          │ 达到 max retries
          ▼
         dead
```

**reconnecting 状态行为**：

```
retry = 0
while retry < RECONNECT_MAX_RETRIES:
  delay = min(RECONNECT_BASE_MS * 2^retry, RECONNECT_MAX_MS)
  delay *= (1 + random(-JITTER, +JITTER))
  await sleep(delay)

  1. 关闭旧 WS（如果还未关）
  2. re-fit xterm → 取当前 term.cols/rows（用户可能在断线期间旋转了设备）
  3. re-fetch token：调 hubWsUrl() 重新获取 auth token
     （iOS PWA 被 OS 回收后 sessionStorage 可能已清空，需要走 /system/auth-check 刷新）
  4. 创建新 WebSocket（新 URL 包含最新 cols/rows/token）
  5. 等待 ws.onopen 或 ws.onerror/onclose

  if ws.onopen:
    // 服务端 attachWithReplay 自动发送 RIS + history + live
    // xterm 收到 RIS (\x1bc) 会清屏重绘
    state → connected
    重置心跳计时器
    retry 计数归零
    break

  if 401/403 → token 已失效且 re-fetch 也失败 → state → dead（不消耗 retry）

  retry++

if retry >= RECONNECT_MAX_RETRIES:
  state → dead
  进入降频探测模式（见 §5.4.1）
```

#### 5.4.1 Dead 状态降频探测

进入 dead 后不彻底放弃。改为每 60s 尝试一次重连（单次，无退避）：
- 成功 → state → connected，恢复正常心跳
- 失败 → 保持 dead，60s 后再试
- 用户手动 retry → 立即尝试，成功则恢复；失败则回到降频节奏

理由：8 次退避总耗时约 2 分钟，够覆盖 svc 正常重启。但如果 tmux server 挂了需要人工干预，2 分钟后进 dead 就彻底放弃会迫使用户手动刷页面。降频探测让用户放着不管也能自动恢复，同时不给已死的服务端造成压力。

### 5.5 xterm 生命周期

**关键设计决策**：重连时**不销毁 xterm 实例**，只替换底层 WS。

理由：
- 服务端重连后第一个字节就是 RIS (`\x1bc`)，会清空 xterm 的 buffer 并重置解析器状态
- 保留 xterm 避免 DOM 抖动（销毁再重建会有短暂白屏）
- CanvasAddon / FitAddon / momentum-scroll 等附加组件不需要重新初始化

**前置 spike（实现前必须验证）**：

xterm 5.x 收到 RIS (`\x1bc`) 时的精确行为需要验证：
1. 是否清空 scrollback buffer（当前配置 `scrollback: 5000`）？
2. 是否重置 alternate screen flag？
3. 是否重置解析器中间状态（半截 escape sequence）？

如果 RIS **不清 scrollback**，重连后用户看到旧 scrollback + 新 replay 拼接，可能出现内容重复。此时需要在重连收到第一个字节前手动调用 `term.clear()` 或 `term.reset()`。

Spike 方法：在浏览器 console 中 `term.write("\x1bc")` 后检查 `term.buffer.normal.length` 和 scrollback 内容。

实现方式：
- `ws` 变量从 `const` 改为 `let`，重连时赋值为新 WebSocket
- `ws.onmessage` / `ws.onclose` / `ws.onerror` 回调复用已有的 `writeTerm` / `consumeOrPassThrough`
- 心跳计时器在旧 WS 关闭时停止，新 WS open 后重启
- `disposed` 守卫保持不变——`close()` 调用后所有操作（包括重连）立即停止

### 5.6 Predictive local-echo 清理

重连时必须清空 `predictions[]` 队列。旧 WS 上的 pending 预测在新连接上没有意义，保留会导致新 WS 第一批数据被错误消费。

### 5.7 Visibility recovery 降级为加速器

```typescript
// mobile-view.ts / desktop-view.ts
onForegroundAfterIdle(3000, () => {
  sse.reconnectIfNeeded();
  term?.probeNow();  // 立即发 ping，不等下一个 heartbeat 周期
});
```

`probeNow()` 语义：立即发送一次 ping + 启动 5s 超时计时器。如果当前已在 reconnecting 状态则 no-op。

**iOS 冻结场景下的实际效果说明**：iOS 冻结期间 `setInterval` 也被冻结，回前台时心跳 timer 的 pending callback 会立刻堆积执行，大概率比 `probeNow` 先触发超时检测。因此 `probeNow` 在 iOS 冻结场景的加速价值有限——它的主要价值在非冻结场景：SSE 断了但 WS 尚未超时的情况下（比如服务端刚重启、SSE 先断 WS 还活着），回前台后 SSE reconnect 成功意味着服务端可达，此时 probeNow 可以提前验证 WS 是否还活着，而不用等下一个 15s 心跳周期。

### 5.8 Reconnecting 期间的 send() 语义

Desktop 模式下 terminal 是可写的，用户在重连期间可能继续打字。需要明确 `send()` 在非 connected 状态下的行为：

| 状态 | send() 行为 |
|------|------------|
| `connected` | 正常发送（现有逻辑） |
| `reconnecting` | 缓冲到 pending queue（上限 64KB），重连成功后按序 flush |
| `dead` | 静默丢弃 |

**Pending queue flush**：重连成功（ws.onopen）后，在心跳计时器启动之前，依次发送 queue 中的消息。如果 flush 过程中 WS 再次断开，残余消息保留在 queue 中等待下一次重连。

**容量上限**：64KB 足够缓冲几十秒的键盘输入（每次击键约 1-10 bytes）。超过上限时丢弃最早的消息，不 toast——用户不太可能在断线期间持续打字超过 64KB。

**Predictive local-echo 交互**：reconnecting 期间 `predictLocalEcho` 正常执行（用户看到自己打的字），但 predictions 在重连成功后被清空（§5.6），所以 replay 数据不会与旧预测冲突。Pending queue 中的 keys 会在 flush 后被服务端 echo 回来，此时新的 predictions 还未积累，echo 正常写入 xterm。

## §6 状态 UI

### 6.1 状态条

重连期间在终端顶部显示一条薄条：

```
┌──────────────────────────────────────────────┐
│ ⟳ reconnecting… (attempt 2/8)                │  ← 半透明浮层
├──────────────────────────────────────────────┤
│                                              │
│  (xterm 终端内容，冻结在断线前最后一帧)        │
│                                              │
└──────────────────────────────────────────────┘
```

- `connected`：隐藏状态条
- `reconnecting`：显示 "reconnecting… (attempt N/8)"，带旋转动画
- `dead`：显示 "connection lost — tap to retry"（mobile）/ "connection lost — click to retry"（desktop），点击重置 retry 计数并重新进入 reconnecting

### 6.2 实现位置

状态条由 view 层（mobile-view / desktop-view）根据 `onStateChange` 回调渲染，不由 terminal.ts 渲染。terminal.ts 不感知 DOM 结构。

## §7 边界情况

| 场景 | 行为 |
|------|------|
| 页面冻结 3 分钟后回来 | JS 解冻 → heartbeat timer 到期 → 发 ping → 5s 无 pong → reconnecting → 新 WS + replay |
| 弱网丢包但 TCP 未断 | heartbeat ping 发出 → 5s 无 pong → reconnecting（即使 readyState 仍 OPEN） |
| WiFi 切蜂窝 | 同上，heartbeat 超时触发重连 |
| 服务端重启 | ws.onclose 触发 → 立即进入 reconnecting → 退避重试直到服务端恢复 |
| 快速切 session（mobile） | 用户 openSession(B) → terminal A 的 close() 置 disposed=true → A 的重连立即停止 → B 正常 attach |
| 重连期间用户切 session | close() 立即停止当前重连循环（disposed gate） |
| 重连成功后第一个 pong 丢了 | 无影响——下一个 heartbeat 周期会重新发 ping |
| 服务端 session 在断线期间被 kill | 重连 WS upgrade 请求返回 410 → 标记 dead + 显示 "session gone" |
| 重连期间 ring buffer 被截断 | 服务端通过 SSE 发 `replay_truncated` 事件 → 已有 toast 路径 |
| pageshow persisted=true (bfcache) | visibility recovery 触发 SSE reconnect + probeNow → 心跳层接管 |
| 多 tab 打开同一 session | 各 tab 独立心跳、独立重连，服务端 broadcaster 支持多 subscriber |
| `close()` 在 reconnecting 期间被调用 | disposed=true 立即中断重连循环，清理所有 timer |
| dead 状态下用户手动 retry | 重置 retry 计数，重新进入 reconnecting |
| dead 状态放着不管 | 每 60s 自动尝试一次重连（降频探测），成功则恢复 connected |
| 断线期间用户旋转设备 | 重连时 re-fit xterm 取最新 cols/rows 建 WS，服务端 pinViewport 按新尺寸渲染 |
| iOS PWA 被 OS 回收后 sessionStorage 清空 | 重连前 re-fetch token（hubWsUrl 自动走 /system/auth-check），auth 不可恢复则进 dead |
| Desktop 可写模式下断线期间用户打字 | 输入缓冲到 pending queue（64KB cap），重连成功后 flush |
| RIS 不清 scrollback（待 spike 验证） | 若确认不清，重连收到数据前手动 `term.clear()` 防止旧内容拼接 |

## §8 与现有模块的关系

### 8.1 保留不动

| 模块 | 理由 |
|------|------|
| `visibility-recovery.ts` | 仍用于 SSE reconnect + probeNow 加速 |
| `sse-client.ts` | 不变——SSE 有自己的 onerror 重连 + reconnectIfNeeded |
| `output-broadcaster.ts` | 服务端不变——broadcaster 始终录制，重连 WS 走现有 attachWithReplay |
| `ring-buffer.ts` | 不变 |
| `momentum-scroll.ts` | 不变——绑定在 xterm el 上，xterm 不销毁则 scroll 不受影响 |

### 8.2 需要修改

| 模块 | 变更 |
|------|------|
| `shared/protocol.ts` | 新增 `ping` / `pong` 消息类型 |
| `server/main.ts` | `websocket.message` 新增 ping → pong 回复分支 |
| `terminal.ts` | 心跳 + 重连状态机 + `onStateChange` 回调 + probeNow |
| `mobile-view.ts` | 移除 visibility-based WS 重连；改为监听 `onStateChange` 显示状态条 |
| `desktop-view.ts` | 同上 |

### 8.3 可删除

| 代码 | 位置 | 理由 |
|------|------|------|
| `if (openedName !== null && term && !term.isConnected)` | mobile-view.ts:188 | 重连由 terminal 自己负责 |
| `if (activeName !== null && term && !term.isConnected) void open(activeName)` | desktop-view.ts:149 | 同上 |

## §9 文件改动清单

| 文件 | 性质 | 估行 |
|------|------|------|
| `src/shared/protocol.ts` | 改 | +5 |
| `src/server/main.ts` | 改 | +8 |
| `src/web/terminal.ts` | 重构 | +120, -20 |
| `src/web/mobile/mobile-view.ts` | 改 | +15, -5 |
| `src/web/desktop/desktop-view.ts` | 改 | +15, -3 |
| `tests/unit/terminal-heartbeat.test.ts` | 新增 | ~150 |
| `tests/unit/terminal-reconnect.test.ts` | 新增 | ~200 |

## §10 实施顺序

1. **协议层**：`protocol.ts` 新增 ping/pong 类型 + `main.ts` 服务端 pong 回复
2. **心跳层**：`terminal.ts` 心跳发送 + pong 接收 + 超时检测（先不做重连，超时只 log）
3. **重连状态机**：`terminal.ts` reconnecting 循环 + xterm 保活 + predictions 清理
4. **状态回调**：`terminal.ts` `onStateChange` API
5. **View 层接入**：mobile-view / desktop-view 监听状态回调、渲染状态条、移除旧的 visibility-based WS 重连
6. **可选加速**：probeNow + visibility recovery 集成
7. **测试**：unit tests for heartbeat + reconnect state machine
8. **手测**：iOS PWA 后台 30s → 回前台验证自动恢复
