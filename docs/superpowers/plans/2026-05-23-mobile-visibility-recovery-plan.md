# Mobile Visibility Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the page returns to foreground after ≥3s hidden, automatically re-attach the current session (full WS rebuild via existing transition path) and force-reconnect SSE — equivalent to today's "switch session twice" recovery, fully automated.

**Architecture:** Add a shared `visibility-recovery` state machine (single `document.visibilitychange` + `window.pageshow(persisted)` listener) that subscribers register against. Mobile-view, desktop-view, and desktop/session-list each register a callback. SSE client gains a `reconnect()` method. Mobile's `openSession` gains a `{ force }` opt to bypass same-target skip in its serial transition queue.

**Tech Stack:** TypeScript, bun test, Vite, xterm.js. No new runtime deps.

**Spec:** `docs/superpowers/specs/2026-05-23-mobile-visibility-recovery-design.md`

**Worktree:** `/Volumes/Data/code/worktrees/tmux-hub/feat-mobile-visibility-recovery/`
All commands assume `cd` to this worktree.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/web/visibility-recovery.ts` | Create | State machine: tracks `hiddenAt`, dispatches to subs on visible/pageshow |
| `tests/unit/visibility-recovery.test.ts` | Create | Threshold, pageshow persisted, multi-sub, cancel, lazy attach/detach |
| `src/web/sse-client.ts` | Modify | Add `reconnect()`; return `SseHandle` instead of bare dispose fn |
| `tests/unit/sse-client.test.ts` | Create | Reconnect closes old ES + cancels pending retry + creates new; idempotent |
| `src/web/mobile/mobile-view.ts` | Modify | `PendingTarget` typed; `openSession({force})`; register visibility cb |
| `src/web/desktop/desktop-view.ts` | Modify | Track `activeName`; register visibility cb |
| `src/web/desktop/session-list.ts` | Modify | Capture `SseHandle`; register visibility cb; wire `sse.stop` into `destroy` |

All three SSE-subscribing modules need the API-change refactor in sse-client.ts to compile, so Task 2 must precede tasks 3 and 4.

---

## Task 1: visibility-recovery module + unit tests (TDD)

**Files:**
- Create: `src/web/visibility-recovery.ts`
- Create: `tests/unit/visibility-recovery.test.ts`

- [ ] **Step 1: Write the first failing test (threshold cross)**

Create `tests/unit/visibility-recovery.test.ts`:

```ts
import { describe, test, expect, mock } from "bun:test";
import { createVisibilityRecovery } from "../../src/web/visibility-recovery";

type Listener = (e: Event) => void;

function makeFakeEnv() {
  const docListeners = new Map<string, Set<Listener>>();
  const winListeners = new Map<string, Set<Listener>>();
  let visibilityState: "visible" | "hidden" = "visible";

  const doc = {
    get visibilityState() { return visibilityState; },
    addEventListener: (type: string, cb: Listener) => {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type)!.add(cb);
    },
    removeEventListener: (type: string, cb: Listener) => {
      docListeners.get(type)?.delete(cb);
    },
  } as unknown as Document;

  const win = {
    addEventListener: (type: string, cb: Listener) => {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type)!.add(cb);
    },
    removeEventListener: (type: string, cb: Listener) => {
      winListeners.get(type)?.delete(cb);
    },
  } as unknown as Window;

  const fireVisibility = (state: "visible" | "hidden") => {
    visibilityState = state;
    docListeners.get("visibilitychange")?.forEach((cb) => cb(new Event("visibilitychange")));
  };

  const firePageShow = (persisted: boolean) => {
    const e = new Event("pageshow") as Event & { persisted: boolean };
    Object.defineProperty(e, "persisted", { value: persisted });
    winListeners.get("pageshow")?.forEach((cb) => cb(e));
  };

  return { doc, win, fireVisibility, firePageShow, docListeners, winListeners };
}

describe("visibility-recovery", () => {
  test("hidden ≥ threshold then visible → callback fires", () => {
    const env = makeFakeEnv();
    let nowMs = 1000;
    const rec = createVisibilityRecovery({ doc: env.doc, win: env.win, now: () => nowMs });
    const cb = mock(() => {});
    rec.onForegroundAfterIdle(3000, cb);

    env.fireVisibility("hidden");
    nowMs += 4000;
    env.fireVisibility("visible");

    expect(cb).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/visibility-recovery.test.ts`
Expected: FAIL with "Cannot find module '../../src/web/visibility-recovery'"

- [ ] **Step 3: Write minimal implementation**

Create `src/web/visibility-recovery.ts`:

```ts
export type ForegroundRecoverCancel = () => void;

type Sub = { thresholdMs: number; cb: () => void };

export type VisibilityRecoveryDeps = {
  doc?: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">;
  win?: Pick<Window, "addEventListener" | "removeEventListener">;
  now?: () => number;
};

export type VisibilityRecovery = {
  onForegroundAfterIdle: (thresholdMs: number, cb: () => void) => ForegroundRecoverCancel;
};

export function createVisibilityRecovery(deps: VisibilityRecoveryDeps = {}): VisibilityRecovery {
  const doc = deps.doc ?? document;
  const win = deps.win ?? window;
  const now = deps.now ?? (() => Date.now());

  let hiddenAt: number | null = null;
  const subs = new Set<Sub>();
  let attached = false;

  const onVisibility = (): void => {
    if (doc.visibilityState === "hidden") {
      hiddenAt = now();
      return;
    }
    if (doc.visibilityState === "visible") {
      if (hiddenAt === null) return;
      const idleMs = now() - hiddenAt;
      hiddenAt = null;
      for (const sub of subs) {
        if (idleMs >= sub.thresholdMs) sub.cb();
      }
    }
  };

  const onPageShow = (e: Event): void => {
    const persisted = (e as PageTransitionEvent).persisted === true;
    if (!persisted) return;
    hiddenAt = null;
    for (const sub of subs) sub.cb();
  };

  const attach = (): void => {
    if (attached) return;
    doc.addEventListener("visibilitychange", onVisibility);
    win.addEventListener("pageshow", onPageShow as EventListener);
    attached = true;
  };

  const detach = (): void => {
    if (!attached) return;
    doc.removeEventListener("visibilitychange", onVisibility);
    win.removeEventListener("pageshow", onPageShow as EventListener);
    attached = false;
    hiddenAt = null;
  };

  const onForegroundAfterIdle = (thresholdMs: number, cb: () => void): ForegroundRecoverCancel => {
    const sub: Sub = { thresholdMs, cb };
    subs.add(sub);
    attach();
    return () => {
      subs.delete(sub);
      if (subs.size === 0) detach();
    };
  };

  return { onForegroundAfterIdle };
}

const _instance = createVisibilityRecovery();
export const onForegroundAfterIdle = _instance.onForegroundAfterIdle;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/visibility-recovery.test.ts`
Expected: 1 pass

- [ ] **Step 5: Add the remaining tests**

Append to `tests/unit/visibility-recovery.test.ts` inside the same `describe`:

```ts
  test("hidden < threshold then visible → callback does NOT fire", () => {
    const env = makeFakeEnv();
    let nowMs = 1000;
    const rec = createVisibilityRecovery({ doc: env.doc, win: env.win, now: () => nowMs });
    const cb = mock(() => {});
    rec.onForegroundAfterIdle(3000, cb);

    env.fireVisibility("hidden");
    nowMs += 1500;
    env.fireVisibility("visible");

    expect(cb).not.toHaveBeenCalled();
  });

  test("visible while hiddenAt === null is a no-op (multiple visible without prior hidden)", () => {
    const env = makeFakeEnv();
    const rec = createVisibilityRecovery({ doc: env.doc, win: env.win, now: () => 0 });
    const cb = mock(() => {});
    rec.onForegroundAfterIdle(3000, cb);

    env.fireVisibility("visible");
    env.fireVisibility("visible");

    expect(cb).not.toHaveBeenCalled();
  });

  test("pageshow persisted=true fires all subs regardless of threshold and clears hiddenAt", () => {
    const env = makeFakeEnv();
    let nowMs = 1000;
    const rec = createVisibilityRecovery({ doc: env.doc, win: env.win, now: () => nowMs });
    const a = mock(() => {});
    const b = mock(() => {});
    rec.onForegroundAfterIdle(99999, a);
    rec.onForegroundAfterIdle(99999, b);

    env.fireVisibility("hidden");
    nowMs += 500;
    env.firePageShow(true);

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    // The trailing visibilitychange→visible after pageshow must NOT re-fire.
    env.fireVisibility("visible");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  test("pageshow persisted=false is a no-op", () => {
    const env = makeFakeEnv();
    const rec = createVisibilityRecovery({ doc: env.doc, win: env.win, now: () => 0 });
    const cb = mock(() => {});
    rec.onForegroundAfterIdle(3000, cb);

    env.firePageShow(false);
    expect(cb).not.toHaveBeenCalled();
  });

  test("two subs with different thresholds — only the one whose threshold is met fires", () => {
    const env = makeFakeEnv();
    let nowMs = 1000;
    const rec = createVisibilityRecovery({ doc: env.doc, win: env.win, now: () => nowMs });
    const short = mock(() => {});
    const long = mock(() => {});
    rec.onForegroundAfterIdle(1000, short);
    rec.onForegroundAfterIdle(5000, long);

    env.fireVisibility("hidden");
    nowMs += 2000;
    env.fireVisibility("visible");

    expect(short).toHaveBeenCalledTimes(1);
    expect(long).not.toHaveBeenCalled();
  });

  test("cancel removes the sub; last cancel detaches global listeners", () => {
    const env = makeFakeEnv();
    let nowMs = 1000;
    const rec = createVisibilityRecovery({ doc: env.doc, win: env.win, now: () => nowMs });
    const cb = mock(() => {});
    const cancel = rec.onForegroundAfterIdle(3000, cb);

    expect(env.docListeners.get("visibilitychange")?.size).toBe(1);
    expect(env.winListeners.get("pageshow")?.size).toBe(1);

    cancel();

    expect(env.docListeners.get("visibilitychange")?.size).toBe(0);
    expect(env.winListeners.get("pageshow")?.size).toBe(0);

    env.fireVisibility("hidden");
    nowMs += 5000;
    env.fireVisibility("visible");
    expect(cb).not.toHaveBeenCalled();
  });

  test("lazy attach: no listeners registered until first sub", () => {
    const env = makeFakeEnv();
    createVisibilityRecovery({ doc: env.doc, win: env.win, now: () => 0 });

    expect(env.docListeners.get("visibilitychange")?.size ?? 0).toBe(0);
    expect(env.winListeners.get("pageshow")?.size ?? 0).toBe(0);
  });
```

- [ ] **Step 6: Run full visibility-recovery test file**

Run: `bun test tests/unit/visibility-recovery.test.ts`
Expected: all tests pass

- [ ] **Step 7: Type-check**

Run: `bunx tsc --noEmit`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add src/web/visibility-recovery.ts tests/unit/visibility-recovery.test.ts
git commit -m "feat(web): visibility-recovery state machine (3s idle + pageshow persisted)"
```

---

## Task 2: SSE reconnect API (TDD)

**Files:**
- Modify: `src/web/sse-client.ts` (full rewrite — 22 lines → ~45 lines)
- Create: `tests/unit/sse-client.test.ts`

- [ ] **Step 1: Write the first failing test**

Create `tests/unit/sse-client.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { subscribeEvents } from "../../src/web/sse-client";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close(): void { this.closed = true; }
}

function freshFake(): typeof EventSource {
  FakeEventSource.instances = [];
  return FakeEventSource as unknown as typeof EventSource;
}

describe("sse-client", () => {
  test("subscribeEvents returns { stop, reconnect } and opens initial ES at /events", () => {
    const ES = freshFake();
    const handle = subscribeEvents(() => {}, { EventSourceCtor: ES });
    expect(typeof handle.stop).toBe("function");
    expect(typeof handle.reconnect).toBe("function");
    expect(FakeEventSource.instances.length).toBe(1);
    expect(FakeEventSource.instances[0]!.url).toBe("/events");
    handle.stop();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/sse-client.test.ts`
Expected: FAIL — `handle.stop` undefined (current API returns a bare function), or "no overload matches" because the second arg is not accepted.

- [ ] **Step 3: Rewrite sse-client.ts**

Replace `src/web/sse-client.ts` contents with:

```ts
import type { ServerEvent } from "@shared/protocol";

export type SseHandle = {
  stop: () => void;
  reconnect: () => void;
};

export type SseDeps = {
  url?: string;
  EventSourceCtor?: typeof EventSource;
};

export function subscribeEvents(
  onEvent: (e: ServerEvent) => void,
  deps: SseDeps = {},
): SseHandle {
  const url = deps.url ?? "/events";
  const ES = deps.EventSourceCtor ?? EventSource;

  let es: EventSource | null = null;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = (): void => {
    if (stopped) return;
    es = new ES(url);
    es.onmessage = (m) => {
      try { onEvent(JSON.parse(m.data) as ServerEvent); } catch { /* drop bad frames */ }
    };
    es.onerror = () => {
      es?.close();
      es = null;
      if (stopped) return;
      retryTimer = setTimeout(() => { retryTimer = null; connect(); }, 1000);
    };
  };

  const stop = (): void => {
    stopped = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    es?.close();
    es = null;
  };

  const reconnect = (): void => {
    if (stopped) return;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    es?.close();
    es = null;
    connect();
  };

  connect();
  return { stop, reconnect };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/sse-client.test.ts`
Expected: 1 pass

- [ ] **Step 5: Add the remaining tests**

Append inside the same `describe`:

```ts
  test("reconnect() closes old ES and opens a new one immediately", () => {
    const ES = freshFake();
    const handle = subscribeEvents(() => {}, { EventSourceCtor: ES });
    const first = FakeEventSource.instances[0]!;
    expect(first.closed).toBe(false);

    handle.reconnect();

    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances.length).toBe(2);
    expect(FakeEventSource.instances[1]!.closed).toBe(false);
    handle.stop();
  });

  test("reconnect() cancels a pending onerror retry so no double-connect 1s later", async () => {
    const ES = freshFake();
    const handle = subscribeEvents(() => {}, { EventSourceCtor: ES });
    const first = FakeEventSource.instances[0]!;

    // Simulate transport error → schedules setTimeout(connect, 1000).
    first.onerror?.();
    expect(FakeEventSource.instances.length).toBe(1); // still 1, retry pending

    handle.reconnect();
    expect(FakeEventSource.instances.length).toBe(2);

    // Wait > 1s and confirm no third instance was opened by the cancelled retry.
    await new Promise((r) => setTimeout(r, 1100));
    expect(FakeEventSource.instances.length).toBe(2);
    handle.stop();
  });

  test("reconnect() called twice in a row is idempotent (no leaked open ES)", () => {
    const ES = freshFake();
    const handle = subscribeEvents(() => {}, { EventSourceCtor: ES });

    handle.reconnect();
    handle.reconnect();

    expect(FakeEventSource.instances.length).toBe(3);
    // Only the latest ES should be open; earlier two closed.
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    expect(FakeEventSource.instances[1]!.closed).toBe(true);
    expect(FakeEventSource.instances[2]!.closed).toBe(false);
    handle.stop();
  });

  test("stop() after reconnect prevents further auto-retry on subsequent errors", async () => {
    const ES = freshFake();
    const handle = subscribeEvents(() => {}, { EventSourceCtor: ES });
    handle.reconnect();
    handle.stop();

    // Simulate error on the latest (now closed via stop) ES; should NOT schedule a retry.
    FakeEventSource.instances[1]!.onerror?.();
    await new Promise((r) => setTimeout(r, 1100));
    expect(FakeEventSource.instances.length).toBe(2);
  });

  test("onmessage parses JSON ServerEvent payloads", () => {
    const ES = freshFake();
    const received: unknown[] = [];
    const handle = subscribeEvents((e) => received.push(e), { EventSourceCtor: ES });
    const first = FakeEventSource.instances[0]!;

    first.onmessage?.({ data: JSON.stringify({ event: "snapshot", payload: [] }) });
    expect(received).toEqual([{ event: "snapshot", payload: [] }]);
    handle.stop();
  });
```

- [ ] **Step 6: Run full sse-client test file**

Run: `bun test tests/unit/sse-client.test.ts`
Expected: all tests pass

- [ ] **Step 7: Type-check / build deferred**

Skip `bunx tsc --noEmit` at this commit — the API change breaks call sites in `mobile-view.ts` and `desktop/session-list.ts` until Tasks 3 and 4 land. Re-run the type check at the end of Task 4 step 5.

- [ ] **Step 8: Commit**

```bash
git add src/web/sse-client.ts tests/unit/sse-client.test.ts
git commit -m "feat(web): sse-client returns SseHandle with reconnect(); cancels pending retry"
```

---

## Task 3: Wire mobile-view to recovery + force-flag openSession

**Files:**
- Modify: `src/web/mobile/mobile-view.ts:2` (import), `:29-87` (pendingTarget + openSession + runTransitions), `:120` (sse capture), `:142` (after subscribe — new visibility hook)

- [ ] **Step 1: Add import for visibility-recovery**

Edit `src/web/mobile/mobile-view.ts`. After the existing imports block (around line 8, after `import { showToast } from "../ui/toast";`) add a new import line:

```ts
import { onForegroundAfterIdle } from "../visibility-recovery";
```

- [ ] **Step 2: Change `pendingTarget` to typed shape and update `runTransitions`**

Find the current block (around `mobile-view.ts:36-78`). The variable + while loop currently look like:

```ts
  let pendingTarget: string | null = null;
  let runningTransition: Promise<void> | null = null;

  const runTransitions = async (): Promise<void> => {
    while (pendingTarget !== null) {
      const target = pendingTarget;
      pendingTarget = null;
      if (target === openedName && term) continue;
      if (!isGrammarOk(target)) continue;
```

Replace with:

```ts
  type PendingTarget = { name: string; force: boolean } | null;
  let pendingTarget: PendingTarget = null;
  let runningTransition: Promise<void> | null = null;

  const runTransitions = async (): Promise<void> => {
    while (pendingTarget !== null) {
      const { name: target, force } = pendingTarget;
      pendingTarget = null;
      if (!force && target === openedName && term) continue;
      if (!isGrammarOk(target)) continue;
```

Further inside the same while loop, the existing post-attach race check (around mobile-view.ts:72) is:

```ts
      // While we were awaiting attachTerminal a newer pick may have arrived.
      // Discard this attach in favour of the next loop iteration.
      if (pendingTarget !== null && pendingTarget !== target) {
        next.close();
        continue;
      }
```

`pendingTarget` is now an object. Replace with:

```ts
      // While we were awaiting attachTerminal a newer pick may have arrived.
      // Discard this attach in favour of the next loop iteration.
      if (pendingTarget !== null && pendingTarget.name !== target) {
        next.close();
        continue;
      }
```

- [ ] **Step 3: Update `openSession` signature**

Find (around mobile-view.ts:80-87):

```ts
  const openSession = (name: string): void => {
    pendingTarget = name;
    if (!runningTransition) {
      runningTransition = runTransitions().finally(() => {
        runningTransition = null;
      });
    }
  };
```

Replace with:

```ts
  const openSession = (name: string, opts?: { force?: boolean }): void => {
    // force=true wins over force=false so a concurrent recovery doesn't
    // get downgraded by a same-target user pick that's still in-queue.
    const force = (opts?.force ?? false) || (pendingTarget?.force ?? false);
    pendingTarget = { name, force };
    if (!runningTransition) {
      runningTransition = runTransitions().finally(() => {
        runningTransition = null;
      });
    }
  };
```

- [ ] **Step 4: Capture SSE handle and register visibility callback**

Find the existing line (around mobile-view.ts:120):

```ts
  subscribeEvents((e: ServerEvent) => {
```

Change that single line to:

```ts
  const sse = subscribeEvents((e: ServerEvent) => {
```

The body and closing `});` stay unchanged.

Then immediately after the `});` that closes the subscribeEvents block (the line `const send = (msg: ClientWsMessage) => { term?.send(msg); };` follows it at the original line 144), insert before that `const send` line:

```ts
  onForegroundAfterIdle(3000, () => {
    sse.reconnect();
    if (openedName !== null) openSession(openedName, { force: true });
  });

```

- [ ] **Step 5: Type-check + run unit tests**

Run: `bunx tsc --noEmit`
Expected: errors still present for `desktop/session-list.ts` (it still uses old SSE API) — that's expected; it lands in Task 4. No errors should be reported for `mobile-view.ts`.

Run: `bun test tests/unit`
Expected: all unit tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/web/mobile/mobile-view.ts
git commit -m "feat(mobile): auto re-attach + SSE reconnect when page returns from >=3s background"
```

---

## Task 4: Wire desktop-view + session-list to recovery

**Files:**
- Modify: `src/web/desktop/desktop-view.ts:1-6` (import), `:27` (activeName decl), `:47-52` (set activeName on success), `:80` (register cb)
- Modify: `src/web/desktop/session-list.ts:2` (import), the tail block (capture sse handle, register cb, wire stop into destroy)

- [ ] **Step 1: Add import + activeName tracker in desktop-view.ts**

Edit `src/web/desktop/desktop-view.ts`. After the existing imports block (around line 6, after `import { hubFetch } from "../hub-fetch";`) add:

```ts
import { onForegroundAfterIdle } from "../visibility-recovery";
```

Find:

```ts
  const list = renderSessionList(left);
  let term: TerminalHandle | null = null;
```

Add a line after:

```ts
  const list = renderSessionList(left);
  let term: TerminalHandle | null = null;
  let activeName: string | null = null;
```

- [ ] **Step 2: Set activeName after successful attach**

Find the existing block in `open` (around desktop-view.ts:47-52):

```ts
    try {
      term = await attachTerminal({ sessionName: name, parent: host });
    } catch (e) {
      showToast(`attach 失败: ${(e as Error).message}`, "error");
      return;
    }
```

Replace with:

```ts
    try {
      term = await attachTerminal({ sessionName: name, parent: host });
      activeName = name;
    } catch (e) {
      showToast(`attach 失败: ${(e as Error).message}`, "error");
      return;
    }
```

- [ ] **Step 3: Register visibility callback**

Find (around desktop-view.ts:80-81):

```ts
  list.onSelect((name) => { void open(name); });
  renderTemplateDrawer(left, (name) => { void open(name); });
```

Add the recovery hook after:

```ts
  list.onSelect((name) => { void open(name); });
  renderTemplateDrawer(left, (name) => { void open(name); });

  onForegroundAfterIdle(3000, () => {
    if (activeName !== null) void open(activeName);
  });
```

- [ ] **Step 4: Wire SSE reconnect into desktop session-list**

Edit `src/web/desktop/session-list.ts`. Find the import at line 2:

```ts
import { subscribeEvents } from "../sse-client";
```

Add another import below it:

```ts
import { subscribeEvents } from "../sse-client";
import { onForegroundAfterIdle } from "../visibility-recovery";
```

Find the tail block (last 10 lines of `renderSessionList`):

```ts
  const unsub = subscribeEvents(apply);
  return {
    el,
    onSelect: (fn) => { selectFn = fn; },
    setActive: (name) => {
      activeName = name;
      refreshActiveMarker();
    },
    destroy: () => { unsub(); el.remove(); },
  };
```

Replace with:

```ts
  const sse = subscribeEvents(apply);
  const cancelRecover = onForegroundAfterIdle(3000, () => sse.reconnect());
  return {
    el,
    onSelect: (fn) => { selectFn = fn; },
    setActive: (name) => {
      activeName = name;
      refreshActiveMarker();
    },
    destroy: () => { cancelRecover(); sse.stop(); el.remove(); },
  };
```

- [ ] **Step 5: Type-check, run tests, build**

Run: `bunx tsc --noEmit`
Expected: no errors anywhere in `src/`.

Run: `bun test`
Expected: lint + all unit + all integration tests pass.

Run: `bun run build`
Expected: vite build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/web/desktop/desktop-view.ts src/web/desktop/session-list.ts
git commit -m "feat(desktop): auto re-attach + SSE reconnect on >=3s foreground return"
```

---

## Task 5: Manual integration verification

This task has no commit. It produces evidence that the feature works end-to-end on real browsers.

- [ ] **Step 1: Start the dev server**

Run: `bun run dev`
Expected: server up on its configured port (check terminal output)

- [ ] **Step 2: Mobile viewport hand-test**

In a Chromium-based browser:

1. Open DevTools, toggle device toolbar (Cmd/Ctrl+Shift+M), select iPhone-class viewport
2. Navigate to the hub URL (auth via CF Access as usual)
3. Pick or quick-launch a session running `watch -n1 date` (any continuously-updating output)
4. In another OS app (or another browser window in focus), wait 4+ seconds
5. Return to the hub browser tab

Expected: terminal shows time continuing to roll forward, not stuck at the time when you left. Console should log a second `[tmux-hub] tui-cursor-gate-v10 attaching to <name>` (the re-attach).

Alternative trigger if tab switching is awkward in DevTools, open DevTools console and run:

```js
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
document.dispatchEvent(new Event("visibilitychange"));
await new Promise(r => setTimeout(r, 4000));
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
document.dispatchEvent(new Event("visibilitychange"));
```

Expected console line: `[tmux-hub] tui-cursor-gate-v10 attaching to <name>` appears again.

- [ ] **Step 3: Desktop viewport hand-test**

Same flow but with the regular desktop layout (wide window). Verify that re-clicking is no longer needed — switching to another OS app for ≥4s then back triggers a fresh attach automatically.

- [ ] **Step 4: Negative case — quick switch under 3s**

Tab away for 1 second, tab back. Expected: NO re-attach (no new `attaching to` log line). Terminal stays connected; if any frames arrived while hidden, they should already be drawn (or arrive immediately on visible).

- [ ] **Step 5: iOS PWA real-device test (optional but high-signal)**

On an iOS device with the hub installed as a PWA:
1. Open the PWA, attach a `watch date` session
2. Home button → wait 30 seconds (or even minutes if you want to stress)
3. Reopen the PWA

Expected: time keeps rolling, no `[hub] connection closed` toast lingering.

If this step fails specifically on iOS but desktop hand-test passed, the most likely culprits are:
- `pageshow persisted=true` event order vs `visibilitychange` — confirm the spec §4 row "pageshow persisted=true 后紧跟 visibilitychange→visible" guard is in place
- iOS killed the JS context entirely (out of scope per spec §8 — no client-side fix possible)

- [ ] **Step 6: Stop the dev server**

`Ctrl+C` in the dev terminal.

---

## Task 6: Open the MR

- [ ] **Step 1: Verify branch state**

Run: `cd /Volumes/Data/code/worktrees/tmux-hub/feat-mobile-visibility-recovery && git status && git log --oneline main..HEAD`

Expected: clean working tree, 5 commits ahead of main (docs/spec, vis-rec, sse-client, mobile, desktop).

- [ ] **Step 2: Push the branch**

```bash
cd /Volumes/Data/code/worktrees/tmux-hub/feat-mobile-visibility-recovery
git push -u origin feat/mobile-visibility-recovery
```

- [ ] **Step 3: Open PR via gh**

```bash
cd /Volumes/Data/code/worktrees/tmux-hub/feat-mobile-visibility-recovery
gh pr create --title "feat(web): auto re-attach session on foreground return (>=3s hidden)" --body "$(cat <<'EOF'
## Summary

- Adds shared visibility-recovery state machine: tracks hiddenAt from visibilitychange, fires subs whose thresholdMs is satisfied; also handles pageshow persisted=true (iOS bfcache restore)
- sse-client now returns SseHandle { stop, reconnect }; reconnect() cancels any pending onerror retry, closes the old ES, and opens a fresh one
- Mobile: openSession({ force: true }) bypasses the same-target skip in the serial transition queue; visibility callback force-re-attaches the current session + reconnects SSE
- Desktop: tracks activeName and re-runs open(activeName) on foreground; session-list reconnects SSE

Equivalent to today's "switch session twice" recovery, fully automated. iOS Safari / PWA after >=3s background, the terminal resumes by itself.

Spec: docs/superpowers/specs/2026-05-23-mobile-visibility-recovery-design.md
Plan: docs/superpowers/plans/2026-05-23-mobile-visibility-recovery-plan.md

## Test plan

- [x] Unit: bun test tests/unit/visibility-recovery.test.ts — 7 cases (threshold, pageshow, multi-sub, cancel, lazy attach)
- [x] Unit: bun test tests/unit/sse-client.test.ts — 6 cases (handle shape, reconnect closes+opens, cancels pending retry, idempotent, stop after reconnect, onmessage parse)
- [x] Type check: bunx tsc --noEmit
- [x] Build: bun run build
- [x] Hand-test: mobile viewport, 4s tab-away → terminal continues rolling
- [x] Hand-test: desktop layout, OS-app switch >=4s → auto re-attach
- [x] Hand-test: <3s switch → no re-attach (negative)
- [ ] Hand-test: real iOS PWA, 30s background → resume (optional)
EOF
)"
```

Expected: PR URL printed to stdout. Paste it back to the user.

---

## Self-Review

Spec coverage check against `docs/superpowers/specs/2026-05-23-mobile-visibility-recovery-design.md`:

| Spec section | Implementing task(s) |
|---|---|
| §3.1 visibility-recovery module | Task 1 |
| §3.2 sse-client reconnect | Task 2 |
| §3.3 mobile-view force + wire | Task 3 |
| §3.4 desktop-view activeName + wire | Task 4 (steps 1-3) |
| §3.5 session-list sse handle + wire | Task 4 (step 4) |
| §4 edge cases | Covered by Task 1 unit tests (pageshow guard, lazy attach, multi-sub, cancel, no-op visible) and Task 2 (reconnect cancels retry, idempotent); Task 3/4 wiring inherits the rest |
| §5.1 unit tests | Task 1 + Task 2 |
| §5.3 E2E | Out of scope of this plan per spec §5 ("E2E optional, hand-test 优先"); Task 5 covers manual equivalent |
| §5.4 hand-test | Task 5 |
| §6 file changeset | Tasks 1-4 file table matches spec §6 |
| §7 implementation order | Tasks 1→2→3→4→5→6 matches spec §7 |
| §8 risks | Task 5 step 5 notes iOS-specific debugging branches |

No placeholder phrases ("TBD", "implement appropriate", etc.). All code blocks contain runnable contents.

Type consistency: `SseHandle`, `ForegroundRecoverCancel`, `PendingTarget`, `VisibilityRecoveryDeps` all defined in Task 1/2 and referenced consistently in Tasks 3/4. `onForegroundAfterIdle` named identically across all 5 consumer sites.
