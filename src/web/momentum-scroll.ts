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
  listenEl: HTMLElement,
  scrollEl: HTMLElement = listenEl,
  options: MomentumOptions = {},
): () => void {
  const opt = { ...DEFAULTS, ...options };

  let raf: number | null = null;
  let tracking = false;
  let lastY = 0;
  let lastTs = 0;
  // Signed velocity in px/ms; positive = scrolling down.
  let velocity = 0;
  // Sub-pixel accumulator. Element.scrollTop only accepts integers, so a
  // 0.6 px/frame update would round-down to 0 every frame and look frozen
  // even though our velocity model is still moving. Accumulate the
  // fractional part across frames and only commit when |acc| >= 1.
  let scrollAcc = 0;
  let lastFrameTs = 0;

  const cancelAnim = () => {
    if (raf !== null) {
      cancelAnimationFrame(raf);
      raf = null;
    }
    lastFrameTs = 0;
    scrollAcc = 0;
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
    // Time-aware step. `friction` is normalised to "decay per 16ms" via
    // Math.pow so the curve is independent of actual frame rate; if the
    // browser drops to 30fps the decay still feels the same. The
    // sub-pixel accumulator below makes sure we don't lose tiny moves to
    // scrollTop's integer rounding.
    const STOP_THRESHOLD = opt.minVelocity * 1.8;
    const step = (now: number): void => {
      if (lastFrameTs === 0) lastFrameTs = now - 16;
      // Clamp huge dt (background tab resume) so we don't teleport.
      const frameDt = Math.min(50, Math.max(1, now - lastFrameTs));
      lastFrameTs = now;

      scrollAcc += velocity * frameDt;
      const integerStep = Math.trunc(scrollAcc);
      if (integerStep !== 0) {
        const max = scrollEl.scrollHeight - scrollEl.clientHeight;
        const next = scrollEl.scrollTop + integerStep;
        if (max <= 0 || next <= 0 || next >= max) {
          scrollEl.scrollTop = clampScroll(next);
          cancelAnim();
          velocity = 0;
          return;
        }
        scrollEl.scrollTop = next;
        scrollAcc -= integerStep;
      }

      velocity *= Math.pow(opt.friction, frameDt / 16);
      if (Math.abs(velocity) > STOP_THRESHOLD) {
        raf = requestAnimationFrame(step);
      } else {
        // Decisive stop: anything below threshold is visually
        // imperceptible and prolongs the perceived "stutter" tail.
        cancelAnim();
        velocity = 0;
      }
    };
    raf = requestAnimationFrame(step);
  };

  listenEl.addEventListener("touchstart", onTouchStart, { passive: true });
  listenEl.addEventListener("touchmove", onTouchMove, { passive: false });
  listenEl.addEventListener("touchend", onTouchEnd, { passive: true });
  listenEl.addEventListener("touchcancel", onTouchEnd, { passive: true });

  return () => {
    cancelAnim();
    listenEl.removeEventListener("touchstart", onTouchStart);
    listenEl.removeEventListener("touchmove", onTouchMove);
    listenEl.removeEventListener("touchend", onTouchEnd);
    listenEl.removeEventListener("touchcancel", onTouchEnd);
  };
}
