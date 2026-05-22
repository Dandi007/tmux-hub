// Custom touch-momentum scroll for the xterm.js viewport on mobile.
//
// Why: iOS Safari natively gives momentum to overflow:scroll containers
// only inconsistently when nested inside other scrollers; xterm.js also
// listens to `scroll` and repaints the canvas, which can stall the
// compositor and make a fling feel sticky. We take over touch entirely
// inside the viewport and animate scrollTop ourselves so the feel matches
// native mobile terminal apps (Termius, Blink).
//
// We attach with `passive: false` on touchmove so we can preventDefault
// and own the scroll. This removes iOS's built-in touch-drag selection
// gesture inside the viewport, but long-press without movement still
// works (we don't intercept touchstart's default behavior).

export type MomentumOptions = {
  // px/ms — minimum velocity to trigger inertia animation
  minVelocity?: number;
  // 0..1 — multiplier applied per animation frame
  friction?: number;
  // ms — half-life for the exponential moving average of velocity
  velocitySmoothingMs?: number;
};

const DEFAULTS: Required<MomentumOptions> = {
  minVelocity: 0.04,
  friction: 0.94,
  velocitySmoothingMs: 30,
};

export function attachMomentumScroll(
  scrollEl: HTMLElement,
  options: MomentumOptions = {},
): () => void {
  const opt = { ...DEFAULTS, ...options };

  let raf: number | null = null;
  let tracking = false;
  let lastY = 0;
  let lastTs = 0;
  // Signed velocity in px/ms; positive = scrolling down.
  let velocity = 0;

  const cancelAnim = () => {
    if (raf !== null) {
      cancelAnimationFrame(raf);
      raf = null;
    }
  };

  const clampScroll = (target: number): number => {
    const max = scrollEl.scrollHeight - scrollEl.clientHeight;
    if (max <= 0) return 0;
    return Math.max(0, Math.min(max, target));
  };

  const onTouchStart = (e: TouchEvent): void => {
    if (e.touches.length !== 1) return;
    cancelAnim();
    const t = e.touches[0]!;
    lastY = t.clientY;
    lastTs = performance.now();
    velocity = 0;
    tracking = true;
  };

  const onTouchMove = (e: TouchEvent): void => {
    if (!tracking || e.touches.length !== 1) return;
    // Block native scroll so it cannot fight our scrollTop updates. We use
    // passive: false on the listener registration below to make this work.
    e.preventDefault();
    const t = e.touches[0]!;
    const now = performance.now();
    const dy = lastY - t.clientY; // positive = scroll down
    const dt = now - lastTs;

    if (dy !== 0) scrollEl.scrollTop = clampScroll(scrollEl.scrollTop + dy);

    if (dt > 0) {
      const instant = dy / dt;
      // Exponential moving average. Weight derived from dt so fast and
      // slow sampling end up with similar response curves.
      const alpha = Math.min(1, dt / opt.velocitySmoothingMs);
      velocity = velocity * (1 - alpha) + instant * alpha;
    }

    lastY = t.clientY;
    lastTs = now;
  };

  const onTouchEnd = (): void => {
    if (!tracking) return;
    tracking = false;
    if (Math.abs(velocity) < opt.minVelocity) {
      velocity = 0;
      return;
    }
    // 16ms per frame is a reasonable assumption for 60fps; the animation
    // will self-correct if frames are dropped because friction is a
    // multiplicative decay independent of frame timing.
    const FRAME_MS = 16;
    const step = (): void => {
      const max = scrollEl.scrollHeight - scrollEl.clientHeight;
      const next = scrollEl.scrollTop + velocity * FRAME_MS;
      if (max <= 0 || next <= 0 || next >= max) {
        scrollEl.scrollTop = clampScroll(next);
        velocity = 0;
        raf = null;
        return;
      }
      scrollEl.scrollTop = next;
      velocity *= opt.friction;
      if (Math.abs(velocity) > opt.minVelocity * 0.5) {
        raf = requestAnimationFrame(step);
      } else {
        velocity = 0;
        raf = null;
      }
    };
    raf = requestAnimationFrame(step);
  };

  scrollEl.addEventListener("touchstart", onTouchStart, { passive: true });
  scrollEl.addEventListener("touchmove", onTouchMove, { passive: false });
  scrollEl.addEventListener("touchend", onTouchEnd, { passive: true });
  scrollEl.addEventListener("touchcancel", onTouchEnd, { passive: true });

  return () => {
    cancelAnim();
    scrollEl.removeEventListener("touchstart", onTouchStart);
    scrollEl.removeEventListener("touchmove", onTouchMove);
    scrollEl.removeEventListener("touchend", onTouchEnd);
    scrollEl.removeEventListener("touchcancel", onTouchEnd);
  };
}
