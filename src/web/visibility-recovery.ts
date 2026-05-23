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
    // bfcache restore: treat as unconditional re-entry — threshold does not apply.
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

// Lazy singleton: only bound to real document/window when first called in a browser context.
let _instance: VisibilityRecovery | undefined;
function _getInstance(): VisibilityRecovery {
  if (!_instance) {
    if (typeof document === "undefined" || typeof window === "undefined") {
      throw new Error("visibility-recovery: onForegroundAfterIdle must be called in a browser context");
    }
    _instance = createVisibilityRecovery();
  }
  return _instance;
}

export const onForegroundAfterIdle = (thresholdMs: number, cb: () => void): ForegroundRecoverCancel =>
  _getInstance().onForegroundAfterIdle(thresholdMs, cb);
