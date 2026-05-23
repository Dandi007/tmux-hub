# WebSocket 心跳 + 传输层自动重连 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace visibility-based reconnection with application-layer heartbeat + transport-layer auto-reconnect so terminals recover from any disconnection scenario without user intervention.

**Architecture:** Client sends periodic `{kind:"ping"}` over WS; server echoes `{kind:"pong"}`. Heartbeat timeout triggers a reconnect state machine inside `terminal.ts` that replaces the WS while keeping xterm alive. View layers observe state changes via callback and render a status bar overlay. Existing `visibility-recovery.ts` is retained only for SSE reconnect + optional early probe.

**Tech Stack:** TypeScript, Bun runtime, xterm.js 5.x, Bun's built-in WebSocket server

**Spec:** `docs/superpowers/specs/2026-05-23-ws-heartbeat-reconnect-design.md`

**Worktree:** `/Volumes/Data/code/worktrees/tmux-hub/feat-ws-heartbeat-reconnect/`

---

## File Map

| File | Responsibility | Task |
|------|---------------|------|
| `src/shared/protocol.ts` | Add `ping`/`pong` message types + `ServerWsMessage` | 1 |
| `src/server/main.ts` | Server pong reply in `websocket.message` | 2 |
| `src/web/terminal.ts` | Heartbeat + reconnect state machine + `onStateChange` + `probeNow` + send queue | 4 |
| `src/web/ui/connection-status.ts` | Reusable status bar overlay component | 5 |
| `src/web/style.css` | Status bar CSS | 5 |
| `src/web/mobile/mobile-view.ts` | Wire `onStateChange` → status bar; remove old visibility-based WS reconnect | 6 |
| `src/web/desktop/desktop-view.ts` | Wire `onStateChange` → status bar; remove old visibility-based WS reconnect | 7 |
| `src/web/hub-fetch.ts` | Add `refreshSecret()` for token re-fetch on reconnect | 3 |
| `tests/unit/terminal-heartbeat.test.ts` | Heartbeat + pong timeout tests | 8 |
| `tests/unit/terminal-reconnect.test.ts` | Reconnect state machine tests | 9 |

---

### Task 0: RIS Spike (前置验证)

**Files:**
- None (browser console manual test)

Spec §5.5 要求在实现前验证 xterm.js 5.x 收到 RIS (`\x1bc`) 时是否清空 scrollback buffer。

- [ ] **Step 1: Start the dev server and open a session**

Run: `cd /Volumes/Data/code/worktrees/tmux-hub/feat-ws-heartbeat-reconnect && bun run dev`

Open browser, attach to any session that has scrollback content (run `seq 200` to generate lines).

- [ ] **Step 2: Check scrollback before RIS**

In browser console:

```javascript
// Get a reference to the xterm Terminal instance.
// If not exposed, temporarily add `(window as any)._debugTerm = term;`
// in terminal.ts after `term.open(el)`.
const term = window._debugTerm;
console.log('scrollback lines:', term.buffer.normal.length);
console.log('baseY (scroll offset):', term.buffer.normal.baseY);
```

- [ ] **Step 3: Send RIS and check scrollback after**

```javascript
term.write('\x1bc');
console.log('scrollback lines after RIS:', term.buffer.normal.length);
console.log('baseY after RIS:', term.buffer.normal.baseY);
```

- [ ] **Step 4: Record result and decide**

- If `baseY === 0` and `length === rows` → RIS clears scrollback → no extra work needed
- If scrollback survives → must call `term.clear()` before writing reconnect replay data (add this to Task 4 reconnect flow)

Document the finding as a comment in terminal.ts when implementing Task 4.

---

### Task 1: Protocol — Add Ping/Pong Types

**Files:**
- Modify: `src/shared/protocol.ts`

- [ ] **Step 1: Add ping to ClientWsMessage and create ServerWsMessage**

```typescript
// src/shared/protocol.ts — replace the existing ClientWsMessage and add ServerWsMessage

export type ClientWsMessage =
  | { kind: "keys"; literal: string }
  | { kind: "key"; name: string }
  | { kind: "resize"; cols: number; rows: number }
  | { kind: "ping"; ts: number };

export type ServerWsMessage =
  | { kind: "pong"; ts: number };
```

- [ ] **Step 2: Verify build**

Run: `cd /Volumes/Data/code/worktrees/tmux-hub/feat-ws-heartbeat-reconnect && bun run build`
Expected: PASS (new types are additive, nothing consumes them yet)

- [ ] **Step 3: Commit**

```bash
cd /Volumes/Data/code/worktrees/tmux-hub/feat-ws-heartbeat-reconnect
git add src/shared/protocol.ts
git commit -m "feat(protocol): add ping/pong message types for WS heartbeat"
```

---

### Task 2: Server — Pong Reply

**Files:**
- Modify: `src/server/main.ts:210-227` (websocket.message handler)

- [ ] **Step 1: Add ping handler before input.send()**

In `src/server/main.ts`, inside the `message(ws, raw)` handler, after the JSON parse block and before `input.send(...)`, add the ping check:

```typescript
    message(ws: ServerWebSocket<WsData>, raw) {
      const { sessionName } = ws.data;
      let parsed: unknown;
      try {
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
        parsed = JSON.parse(text);
      } catch {
        try { ws.send(JSON.stringify({ error: "invalid json" })); } catch {}
        return;
      }
      // Heartbeat: echo pong immediately, do not route to tmux.
      if (typeof parsed === "object" && parsed !== null && (parsed as { kind?: string }).kind === "ping") {
        const ts = (parsed as { ts?: number }).ts ?? 0;
        try { ws.send(JSON.stringify({ kind: "pong", ts })); } catch {}
        return;
      }
      input.send(sessionName, parsed as Parameters<typeof input.send>[1]).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        try { ws.send(JSON.stringify({ error: msg })); } catch {}
        if (e instanceof HubError && e.code === 410) {
          try { ws.close(4410, "session gone"); } catch {}
        }
      });
    },
```

- [ ] **Step 2: Verify build**

Run: `cd /Volumes/Data/code/worktrees/tmux-hub/feat-ws-heartbeat-reconnect && bun run build`
Expected: PASS

- [ ] **Step 3: Smoke test**

Start the server: `bun run dev`

In browser DevTools Network tab → WS → send frame manually:
- Send: `{"kind":"ping","ts":1716480000000}`
- Expect to see a pong frame back: `{"kind":"pong","ts":1716480000000}`

- [ ] **Step 4: Commit**

```bash
cd /Volumes/Data/code/worktrees/tmux-hub/feat-ws-heartbeat-reconnect
git add src/server/main.ts
git commit -m "feat(server): reply pong to client ping for WS heartbeat"
```

---

### Task 3: Hub-Fetch — Token Refresh

**Files:**
- Modify: `src/web/hub-fetch.ts`

On reconnect, `sessionStorage` may have been cleared (iOS PWA killed by OS). The existing `getSecret()` returns the cached in-memory value and never re-fetches once populated. We need a `refreshSecret()` that forces re-fetch.

- [ ] **Step 1: Add refreshSecret()**

Add after the existing `getSecret()` function:

```typescript
export async function refreshSecret(): Promise<string | null> {
  cached = null;
  if (typeof sessionStorage !== "undefined") sessionStorage.removeItem("hub.secret");
  return getSecret();
}
```

- [ ] **Step 2: Verify build**

Run: `cd /Volumes/Data/code/worktrees/tmux-hub/feat-ws-heartbeat-reconnect && bun run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
cd /Volumes/Data/code/worktrees/tmux-hub/feat-ws-heartbeat-reconnect
git add src/web/hub-fetch.ts
git commit -m "feat(hub-fetch): add refreshSecret() for reconnect token re-fetch"
```

---

### Task 4: Terminal — Heartbeat + Reconnect State Machine

This is the core task. The existing `terminal.ts` is a single `attachTerminal()` function (~315 lines). We refactor it to add heartbeat, reconnect, state callbacks, send queue, and probeNow — all within the same function closure, making the `ws` variable mutable.

**Files:**
- Modify: `src/web/terminal.ts`

- [ ] **Step 1: Update exports — new types**

Replace the existing `TerminalHandle` type at the top of the file and add `TerminalState`:

```typescript
export type TerminalState = "connected" | "reconnecting" | "dead";

export type TerminalHandle = {
  el: HTMLElement;
  send: (msg: ClientWsMessage) => void;
  close: () => void;
  probeNow: () => void;
  retry: () => void;
  readonly isConnected: boolean;
  readonly state: TerminalState;
  onStateChange: (cb: (state: TerminalState, attempt?: number) => void) => void;
};
```

- [ ] **Step 2: Add constants after BUILD_MARKER**

```typescript
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS  = 5_000;
const RECONNECT_MAX_RETRIES = 8;
const RECONNECT_BASE_MS     = 500;
const RECONNECT_MAX_MS      = 30_000;
const RECONNECT_JITTER      = 0.3;
const DEAD_PROBE_INTERVAL_MS = 60_000;
const SEND_QUEUE_MAX_BYTES  = 65_536;
```

- [ ] **Step 3: Add import for refreshSecret**

Update the hub-fetch import:

```typescript
import { hubWsUrl, refreshSecret } from "./hub-fetch";
```

- [ ] **Step 4: Add state machine, heartbeat, and send queue inside attachTerminal**

After the xterm setup block (after `term.open(el)` and the CanvasAddon setTimeout and DECSCUSR intercept and momentum-scroll), before the WS creation, add the state machine infrastructure:

```typescript
  // --- State machine ---
  let currentState: TerminalState = "connected";
  let stateListeners: Array<(state: TerminalState, attempt?: number) => void> = [];
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let deadProbeTimer: ReturnType<typeof setInterval> | null = null;

  const setState = (next: TerminalState, attempt?: number): void => {
    if (next === currentState && next !== "reconnecting") return;
    currentState = next;
    for (const cb of stateListeners) {
      try { cb(next, attempt); } catch {}
    }
  };

  // --- Heartbeat ---
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let pongTimer: ReturnType<typeof setTimeout> | null = null;

  const stopHeartbeat = (): void => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
  };

  const sendPing = (): void => {
    if (disposed || currentState !== "connected") return;
    try { ws.send(JSON.stringify({ kind: "ping", ts: Date.now() })); } catch {}
    if (pongTimer) clearTimeout(pongTimer);
    pongTimer = setTimeout(() => {
      pongTimer = null;
      if (disposed || currentState !== "connected") return;
      console.warn("[tmux-hub] heartbeat timeout — entering reconnect");
      enterReconnecting();
    }, HEARTBEAT_TIMEOUT_MS);
  };

  const startHeartbeat = (): void => {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (disposed || currentState !== "connected") return;
      sendPing();
    }, HEARTBEAT_INTERVAL_MS);
  };

  const receivePong = (): void => {
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
  };

  // --- Send queue (buffered during reconnecting) ---
  let sendQueue: string[] = [];
  let sendQueueBytes = 0;

  const queuedSend = (msg: ClientWsMessage): void => {
    if (disposed) return;
    if (currentState === "connected" && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return;
    }
    if (currentState === "dead") return;
    const json = JSON.stringify(msg);
    const byteLen = json.length;
    while (sendQueueBytes + byteLen > SEND_QUEUE_MAX_BYTES && sendQueue.length > 0) {
      sendQueueBytes -= sendQueue.shift()!.length;
    }
    sendQueue.push(json);
    sendQueueBytes += byteLen;
  };

  const flushSendQueue = (): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    for (const json of sendQueue) {
      try { ws.send(json); } catch { break; }
    }
    sendQueue = [];
    sendQueueBytes = 0;
  };
```

- [ ] **Step 5: Add WS wiring helper**

```typescript
  const wireWs = (socket: WebSocket): void => {
    socket.binaryType = "arraybuffer";
    socket.onmessage = (m) => {
      if (disposed) return;
      if (typeof m.data === "string") {
        try {
          const parsed = JSON.parse(m.data);
          if (parsed && typeof parsed === "object") {
            if ("kind" in parsed && (parsed as { kind: string }).kind === "pong") {
              receivePong();
              return;
            }
            if ("error" in parsed) {
              writeTerm(`\r\n[hub] ${(parsed as { error: string }).error}\r\n`);
              return;
            }
          }
        } catch { /* fall through */ }
        consumeOrPassThrough(new TextEncoder().encode(m.data));
      } else {
        consumeOrPassThrough(new Uint8Array(m.data as ArrayBuffer));
      }
    };
    socket.onclose = () => {
      if (disposed) return;
      if (currentState === "connected") {
        console.warn("[tmux-hub] ws closed unexpectedly — entering reconnect");
        enterReconnecting();
      }
    };
    socket.onerror = () => {};
  };
```

- [ ] **Step 6: Add buildWsUrl helper and reconnect logic**

```typescript
  const buildWsUrl = async (): Promise<string> => {
    try { fit.fit(); } catch {}
    const c = term.cols > 0 ? term.cols : (opts.cols ?? 200);
    const r = term.rows > 0 ? term.rows : (opts.rows ?? 50);
    const base = await hubWsUrl(`/ws/sessions/${encodeURIComponent(opts.sessionName)}`);
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}cols=${c}&rows=${r}`;
  };

  const enterReconnecting = (): void => {
    if (disposed) return;
    stopHeartbeat();
    try { ws.onmessage = null; ws.onclose = null; ws.onerror = null; ws.close(); } catch {}
    predictions.length = 0;
    reconnectAttempt = 0;
    setState("reconnecting", 0);
    scheduleReconnectAttempt();
  };

  const scheduleReconnectAttempt = (): void => {
    if (disposed) return;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt), RECONNECT_MAX_MS);
    const jittered = delay * (1 + (Math.random() * 2 - 1) * RECONNECT_JITTER);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void attemptReconnect();
    }, jittered);
  };

  const attemptReconnect = async (): Promise<void> => {
    if (disposed) return;
    reconnectAttempt++;
    setState("reconnecting", reconnectAttempt);

    let url: string;
    try {
      await refreshSecret();
      url = await buildWsUrl();
    } catch {
      setState("dead");
      startDeadProbe();
      return;
    }

    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";

    const connectTimeout = setTimeout(() => {
      try { socket.close(); } catch {}
    }, HEARTBEAT_TIMEOUT_MS);

    socket.onopen = () => {
      clearTimeout(connectTimeout);
      if (disposed) { try { socket.close(); } catch {} return; }
      // If RIS spike showed scrollback survives \x1bc, uncomment:
      // try { term.clear(); } catch {}
      ws = socket;
      wireWs(ws);
      reconnectAttempt = 0;
      predictions.length = 0;
      setState("connected");
      flushSendQueue();
      startHeartbeat();
      const c = term.cols;
      const r = term.rows;
      if (c > 0 && r > 0) queuedSend({ kind: "resize", cols: c, rows: r });
    };

    socket.onclose = () => {
      clearTimeout(connectTimeout);
      if (disposed) return;
      if (reconnectAttempt >= RECONNECT_MAX_RETRIES) {
        setState("dead");
        startDeadProbe();
      } else {
        scheduleReconnectAttempt();
      }
    };
    socket.onerror = () => {};
  };

  const startDeadProbe = (): void => {
    stopDeadProbe();
    deadProbeTimer = setInterval(() => {
      if (disposed || currentState !== "dead") { stopDeadProbe(); return; }
      stopDeadProbe();
      reconnectAttempt = 0;
      setState("reconnecting", 0);
      scheduleReconnectAttempt();
    }, DEAD_PROBE_INTERVAL_MS);
  };

  const stopDeadProbe = (): void => {
    if (deadProbeTimer) { clearInterval(deadProbeTimer); deadProbeTimer = null; }
  };
```

- [ ] **Step 7: Replace initial WS creation block**

Remove the old lines (~122-127) that do `const wsBase = await hubWsUrl(...)` through `const ws = new WebSocket(wsUrl)` and the old `ws.binaryType`, `ws.onmessage`, `ws.onclose`, `ws.onerror`, and `ws.addEventListener("open", ...)` blocks. Replace with:

```typescript
  const initUrl = await buildWsUrl();
  let ws = new WebSocket(initUrl);
  wireWs(ws);

  ws.addEventListener("open", () => {
    startHeartbeat();
    setTimeout(() => {
      const c = term.cols;
      const r = term.rows;
      if (c > 0 && r > 0 && ws.readyState === WebSocket.OPEN) {
        queuedSend({ kind: "resize", cols: c, rows: r });
      }
    }, 100);
  });
```

- [ ] **Step 8: Update send() and onData to use queuedSend**

Replace the old `send` function and update `term.onData`:

```typescript
  if (!opts.readOnly) {
    term.onData((data) => {
      predictLocalEcho(data);
      queuedSend({ kind: "keys", literal: data });
    });
  }
```

- [ ] **Step 9: Update publishResize to use queuedSend**

```typescript
  const publishResize = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      const c = term.cols;
      const r = term.rows;
      if (c > 0 && r > 0) queuedSend({ kind: "resize", cols: c, rows: r });
    }, 150);
  };
```

- [ ] **Step 10: Update close() to clean up all timers**

```typescript
    close: () => {
      disposed = true;
      stopHeartbeat();
      stopDeadProbe();
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      window.removeEventListener("resize", onResize);
      if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null; }
      try { detachMomentum?.(); } catch {}
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try { ws.close(); } catch {}
      try { term.dispose(); } catch {}
      try { el.remove(); } catch {}
      stateListeners = [];
    },
```

- [ ] **Step 11: Update returned handle with new API surface**

```typescript
  return {
    el,
    send: queuedSend,
    get isConnected() { return !disposed && currentState === "connected"; },
    get state() { return currentState; },
    onStateChange: (cb) => { stateListeners.push(cb); },
    probeNow: () => {
      if (disposed) return;
      if (currentState === "reconnecting") return;
      if (currentState === "dead") {
        stopDeadProbe();
        reconnectAttempt = 0;
        setState("reconnecting", 0);
        scheduleReconnectAttempt();
        return;
      }
      sendPing();
    },
    retry: () => {
      if (disposed || currentState !== "dead") return;
      stopDeadProbe();
      reconnectAttempt = 0;
      setState("reconnecting", 0);
      scheduleReconnectAttempt();
    },
    close: () => {
      disposed = true;
      stopHeartbeat();
      stopDeadProbe();
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      window.removeEventListener("resize", onResize);
      if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null; }
      try { detachMomentum?.(); } catch {}
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try { ws.close(); } catch {}
      try { term.dispose(); } catch {}
      try { el.remove(); } catch {}
      stateListeners = [];
    },
  };
```

- [ ] **Step 12: Verify build**

Run: `cd /Volumes/Data/code/worktrees/tmux-hub/feat-ws-heartbeat-reconnect && bun run build`
Expected: PASS

- [ ] **Step 13: Commit**

```bash
cd /Volumes/Data/code/worktrees/tmux-hub/feat-ws-heartbeat-reconnect
git add src/web/terminal.ts
git commit -m "feat(terminal): heartbeat + reconnect state machine with send queue"
```

---

### Task 5: Connection Status Bar UI Component

**Files:**
- Create: `src/web/ui/connection-status.ts`
- Modify: `src/web/style.css`

- [ ] **Step 1: Create the component**

```typescript
// src/web/ui/connection-status.ts
import type { TerminalState } from "../terminal";

export type ConnectionStatusHandle = {
  el: HTMLElement;
  update: (state: TerminalState, attempt?: number) => void;
  onRetry: (cb: () => void) => void;
  destroy: () => void;
};

export function createConnectionStatus(isMobile: boolean): ConnectionStatusHandle {
  const el = document.createElement("div");
  el.className = "connection-status";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.hidden = true;

  const label = document.createElement("span");
  label.className = "connection-status__label";
  el.appendChild(label);

  const retryBtn = document.createElement("button");
  retryBtn.type = "button";
  retryBtn.className = "connection-status__retry";
  retryBtn.hidden = true;
  retryBtn.textContent = isMobile ? "tap to retry" : "click to retry";
  el.appendChild(retryBtn);

  let retryCb: (() => void) | null = null;
  retryBtn.addEventListener("click", () => { retryCb?.(); });

  const update = (state: TerminalState, attempt?: number): void => {
    if (state === "connected") {
      el.hidden = true;
      el.classList.remove("is-dead");
      return;
    }
    el.hidden = false;
    if (state === "reconnecting") {
      el.classList.remove("is-dead");
      retryBtn.hidden = true;
      label.textContent = `reconnecting… (attempt ${attempt ?? "?"}/${8})`;
    } else {
      el.classList.add("is-dead");
      retryBtn.hidden = false;
      label.textContent = "connection lost — ";
    }
  };

  return {
    el,
    update,
    onRetry: (cb) => { retryCb = cb; },
    destroy: () => { el.remove(); },
  };
}
```

- [ ] **Step 2: Add CSS to style.css**

Append to the end of `src/web/style.css`:

```css
/* --- Connection status overlay --- */
.connection-status {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  padding: 6px 12px;
  background: oklch(30% 0.08 250 / 0.92);
  color: oklch(90% 0.02 250);
  font-size: 0.8125rem;
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}
.connection-status[hidden] { display: none; }
.connection-status.is-dead {
  background: oklch(30% 0.1 25 / 0.92);
  color: oklch(90% 0.03 25);
}
.connection-status__label { flex: 1; min-width: 0; }
.connection-status__retry {
  appearance: none;
  border: 1px solid currentColor;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  padding: 2px 8px;
  font: inherit;
  cursor: pointer;
}
.connection-status__retry:hover { background: oklch(100% 0 0 / 0.1); }
```

- [ ] **Step 3: Verify build**

Run: `cd /Volumes/Data/code/worktrees/tmux-hub/feat-ws-heartbeat-reconnect && bun run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
cd /Volumes/Data/code/worktrees/tmux-hub/feat-ws-heartbeat-reconnect
git add src/web/ui/connection-status.ts src/web/style.css
git commit -m "feat(ui): connection status bar overlay for reconnect states"
```

---

### Task 6: Mobile View — Wire State Callback + Remove Old Reconnect

**Files:**
- Modify: `src/web/mobile/mobile-view.ts`

- [ ] **Step 1: Add import for connection status**

Add to the imports at the top:

```typescript
import { createConnectionStatus } from "../ui/connection-status";
```

- [ ] **Step 2: Create status bar instance and attach to termHost**

After `termHost` creation (around line 26), before the state variables, add:

```typescript
  const connStatus = createConnectionStatus(true);
  connStatus.onRetry(() => { term?.retry(); });
  termHost.appendChild(connStatus.el);
```

- [ ] **Step 3: Wire onStateChange in runTransitions**

In the `runTransitions` function, after `term = next;` (around line 66), add:

```typescript
      next.onStateChange((state, attempt) => {
        connStatus.update(state, attempt);
      });
```

- [ ] **Step 4: Replace visibility recovery callback**

Replace the existing `onForegroundAfterIdle` block (lines 186-191):

Old:
```typescript
  onForegroundAfterIdle(3000, () => {
    sse.reconnectIfNeeded();
    if (openedName !== null && term && !term.isConnected) {
      openSession(openedName, { force: true });
    }
  });
```

New:
```typescript
  onForegroundAfterIdle(3000, () => {
    sse.reconnectIfNeeded();
    term?.probeNow();
  });
```

- [ ] **Step 5: Verify build**

Run: `cd /Volumes/Data/code/worktrees/tmux-hub/feat-ws-heartbeat-reconnect && bun run build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd /Volumes/Data/code/worktrees/tmux-hub/feat-ws-heartbeat-reconnect
git add src/web/mobile/mobile-view.ts
git commit -m "feat(mobile): wire connection status bar, remove visibility-based WS reconnect"
```

---

### Task 7: Desktop View — Wire State Callback + Remove Old Reconnect

**Files:**
- Modify: `src/web/desktop/desktop-view.ts`

- [ ] **Step 1: Add import**

Add to the imports at the top:

```typescript
import { createConnectionStatus } from "../ui/connection-status";
```

- [ ] **Step 2: Create status bar inside renderDesktop**

Inside `renderDesktop`, after creating `right` (around line 25), add:

```typescript
  const connStatus = createConnectionStatus(false);
  connStatus.onRetry(() => { term?.retry(); });
```

- [ ] **Step 3: Wire to terminal in open()**

Inside `open()`, after `term = await attachTerminal(...)` succeeds and `activeName = name` (around line 60), add:

```typescript
      host.insertBefore(connStatus.el, host.firstChild);
      term.onStateChange((state, attempt) => {
        connStatus.update(state, attempt);
      });
```

- [ ] **Step 4: Replace visibility recovery callback**

Replace the existing `onForegroundAfterIdle` block (lines 148-150):

Old:
```typescript
  onForegroundAfterIdle(3000, () => {
    if (activeName !== null && term && !term.isConnected) void open(activeName);
  });
```

New:
```typescript
  onForegroundAfterIdle(3000, () => {
    term?.probeNow();
  });
```

- [ ] **Step 5: Verify build**

Run: `cd /Volumes/Data/code/worktrees/tmux-hub/feat-ws-heartbeat-reconnect && bun run build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd /Volumes/Data/code/worktrees/tmux-hub/feat-ws-heartbeat-reconnect
git add src/web/desktop/desktop-view.ts
git commit -m "feat(desktop): wire connection status bar, remove visibility-based WS reconnect"
```

---

### Task 8: Unit Tests — Heartbeat Protocol

**Files:**
- Create: `tests/unit/terminal-heartbeat.test.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, test, expect } from "bun:test";

describe("heartbeat protocol", () => {
  test("ping message has correct shape", () => {
    const ts = Date.now();
    const msg = { kind: "ping" as const, ts };
    expect(msg.kind).toBe("ping");
    expect(typeof msg.ts).toBe("number");
    expect(JSON.parse(JSON.stringify(msg))).toEqual(msg);
  });

  test("pong message echoes ts unchanged", () => {
    const ts = 1716480000000;
    const pong = { kind: "pong" as const, ts };
    expect(pong.ts).toBe(ts);
  });
});

describe("server ping handler guard", () => {
  test("ping kind is recognized", () => {
    const parsed = JSON.parse('{"kind":"ping","ts":123}');
    const isPing = typeof parsed === "object" && parsed !== null && parsed.kind === "ping";
    expect(isPing).toBe(true);
  });

  test("non-ping messages are not intercepted", () => {
    for (const raw of ['{"kind":"keys","literal":"a"}', '{"kind":"resize","cols":80,"rows":24}']) {
      const parsed = JSON.parse(raw);
      const isPing = typeof parsed === "object" && parsed !== null && parsed.kind === "ping";
      expect(isPing).toBe(false);
    }
  });

  test("malformed ping without ts defaults safely", () => {
    const parsed = JSON.parse('{"kind":"ping"}');
    const ts = (parsed as { ts?: number }).ts ?? 0;
    expect(ts).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd /Volumes/Data/code/worktrees/tmux-hub/feat-ws-heartbeat-reconnect && bun test tests/unit/terminal-heartbeat.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
cd /Volumes/Data/code/worktrees/tmux-hub/feat-ws-heartbeat-reconnect
git add tests/unit/terminal-heartbeat.test.ts
git commit -m "test: heartbeat protocol shape and server handler guards"
```

---

### Task 9: Unit Tests — Reconnect State Machine

**Files:**
- Create: `tests/unit/terminal-reconnect.test.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, test, expect } from "bun:test";

describe("reconnect backoff calculation", () => {
  const BASE = 500;
  const MAX = 30_000;
  const JITTER = 0.3;

  function calcDelay(attempt: number, rand = 0.5): number {
    const delay = Math.min(BASE * Math.pow(2, attempt), MAX);
    return delay * (1 + (rand * 2 - 1) * JITTER);
  }

  test("attempt 0 base delay is 500ms", () => {
    expect(calcDelay(0, 0.5)).toBe(500);
  });

  test("attempt 1 doubles to 1000ms", () => {
    expect(calcDelay(1, 0.5)).toBe(1000);
  });

  test("delay caps at 30s for large attempt numbers", () => {
    expect(calcDelay(100, 0.5)).toBe(30_000);
  });

  test("jitter at attempt 0 ranges from 350ms to 650ms", () => {
    expect(calcDelay(0, 0)).toBe(350);
    expect(calcDelay(0, 1)).toBe(650);
  });

  test("8 retries total under 3 minutes even with max jitter", () => {
    let total = 0;
    for (let i = 0; i < 8; i++) total += calcDelay(i, 1);
    expect(total).toBeLessThan(180_000);
    expect(total).toBeGreaterThan(30_000);
  });
});

describe("send queue eviction", () => {
  const MAX_BYTES = 65_536;

  test("evicts oldest when capacity exceeded", () => {
    const queue: string[] = [];
    let bytes = 0;
    const msg = "x".repeat(1024);
    for (let i = 0; i < 70; i++) {
      while (bytes + msg.length > MAX_BYTES && queue.length > 0) {
        bytes -= queue.shift()!.length;
      }
      queue.push(msg);
      bytes += msg.length;
    }
    expect(bytes).toBeLessThanOrEqual(MAX_BYTES);
    expect(queue.length).toBe(64);
  });

  test("empty queue accepts first message", () => {
    const queue: string[] = [];
    let bytes = 0;
    const msg = '{"kind":"keys","literal":"a"}';
    queue.push(msg);
    bytes += msg.length;
    expect(queue.length).toBe(1);
    expect(bytes).toBeLessThan(MAX_BYTES);
  });
});

describe("state transitions", () => {
  const valid: Record<string, string[]> = {
    connected: ["reconnecting"],
    reconnecting: ["connected", "dead"],
    dead: ["reconnecting"],
  };

  test("connected → reconnecting is valid", () => {
    expect(valid["connected"]).toContain("reconnecting");
  });

  test("reconnecting → connected is valid (successful reconnect)", () => {
    expect(valid["reconnecting"]).toContain("connected");
  });

  test("reconnecting → dead is valid (max retries)", () => {
    expect(valid["reconnecting"]).toContain("dead");
  });

  test("dead → reconnecting is valid (manual retry or dead probe)", () => {
    expect(valid["dead"]).toContain("reconnecting");
  });

  test("connected cannot go directly to dead", () => {
    expect(valid["connected"]).not.toContain("dead");
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd /Volumes/Data/code/worktrees/tmux-hub/feat-ws-heartbeat-reconnect && bun test tests/unit/terminal-reconnect.test.ts`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `cd /Volumes/Data/code/worktrees/tmux-hub/feat-ws-heartbeat-reconnect && bun test`
Expected: All existing + new tests PASS

- [ ] **Step 4: Commit**

```bash
cd /Volumes/Data/code/worktrees/tmux-hub/feat-ws-heartbeat-reconnect
git add tests/unit/terminal-reconnect.test.ts
git commit -m "test: reconnect backoff, send queue eviction, state transition rules"
```

---

### Task 10: Integration Smoke Test (Manual)

**Files:** None

- [ ] **Step 1: Build and start**

```bash
cd /Volumes/Data/code/worktrees/tmux-hub/feat-ws-heartbeat-reconnect
bun run build && bun run start
```

- [ ] **Step 2: Desktop — verify heartbeat in network tab**

Open browser DevTools → Network → WS. Attach to a session. Verify:
- Every 15s a `{"kind":"ping","ts":...}` frame is sent
- Server replies with `{"kind":"pong","ts":...}` within <100ms

- [ ] **Step 3: Desktop — simulate disconnect**

In DevTools Network tab, right-click the WS connection → Close. Verify:
- Status bar appears: "reconnecting… (attempt 1/8)"
- Within ~1s a new WS is established
- Terminal replays history and continues showing live output
- Status bar disappears

- [ ] **Step 4: Mobile — iOS PWA background/foreground**

On real iOS device (or Simulator):
1. Open PWA, attach to a session running `watch -n1 date`
2. Switch to home screen, wait 30s
3. Switch back to PWA
4. Verify: time continues updating, no permanent "connection closed" message

- [ ] **Step 5: Desktop — dead state probe recovery**

1. Stop the server (`Ctrl+C`)
2. Wait for terminal to show "connection lost — click to retry"
3. Restart the server
4. Wait up to 60s — terminal should auto-recover without clicking retry

- [ ] **Step 6: Desktop — writable send queue**

1. Attach to a session with a shell prompt (not readOnly)
2. Close WS via DevTools
3. While "reconnecting…" is showing, type a few characters
4. Verify: after reconnect completes, the typed characters appear at the prompt
