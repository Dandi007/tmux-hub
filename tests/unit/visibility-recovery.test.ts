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
});
