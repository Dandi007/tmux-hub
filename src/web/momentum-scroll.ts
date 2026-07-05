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

export type WheelDirection = "up" | "down";

export type MomentumOptions = {
  // px/ms — minimum velocity to trigger inertia animation
  minVelocity?: number;
  // 0..1 — multiplier applied per animation frame
  friction?: number;
  // ms — half-life for the exponential moving average of velocity
  velocitySmoothingMs?: number;
  // When this returns true at the start of a gesture, vertical drags are
  // forwarded as mouse-wheel ticks (via onWheel) instead of scrolling local
  // scrollback. Used for alternate-screen TUI apps (claude code, vim, less)
  // that own their off-screen content and run in mouse mode — there is no
  // local scrollback to move, so we let the app scroll itself.
  shouldForwardWheel?: () => boolean;
  // Emit `notches` wheel ticks in `direction` at the touch point.
  onWheel?: (direction: WheelDirection, notches: number, clientX: number, clientY: number) => void;
  // px of drag that equals one wheel tick when forwarding.
  wheelPxPerNotch?: number;
  // px — current xterm row height. When provided, inertia writes are
  // quantized to whole rows so xterm's own row-realign write-back
  // (Viewport._innerRefresh: scrollTop = ydisp*rowHeight) equals what we
  // wrote and never trips the external-change guard. 0/undefined = unknown.
  rowHeightPx?: () => number;
};

const DEFAULTS: Required<Omit<MomentumOptions, "shouldForwardWheel" | "onWheel" | "rowHeightPx">> = {
  minVelocity: 0.04,
  friction: 0.94,
  velocitySmoothingMs: 30,
  wheelPxPerNotch: 24,
};

/**
 * Pure helper: convert accumulated drag pixels into discrete wheel ticks.
 * Positive `accPx` (finger moved up → content scrolls toward newer) maps to
 * "down"; negative maps to "up". Returns whole `notches` plus the leftover
 * `remainderPx` to carry into the next move so sub-tick drags aren't lost.
 */
export function dragToWheel(
  accPx: number,
  pxPerNotch: number,
): { notches: number; direction: WheelDirection; remainderPx: number } {
  const direction: WheelDirection = accPx >= 0 ? "down" : "up";
  if (pxPerNotch <= 0) return { notches: 0, direction, remainderPx: accPx };
  const notches = Math.floor(Math.abs(accPx) / pxPerNotch);
  const sign = accPx >= 0 ? 1 : -1;
  const remainderPx = accPx - sign * notches * pxPerNotch;
  return { notches, direction, remainderPx };
}

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
  // The scrollTop value momentum itself last wrote (or null before the first
  // write). Used to detect when an external actor (xterm appending output →
  // pinning the viewport to bottom, the user touching the scrollbar, another
  // momentum gesture) has moved the viewport out from under us. When that
  // happens the in-flight inertia is no longer pointing where the user
  // expects, so we halt rather than fight the external position — this is
  // what stops the "拉到顶又弹回 / 跳到最顶上" race on Kimi/Codex sessions
  // where new output arrives mid-fling.
  let expectedScrollTop: number | null = null;
  // Wheel-forwarding state. Decided once per gesture at touchstart so a drag
  // can't flip modes mid-stroke. wheelAcc carries sub-tick drag pixels across
  // moves so slow drags still accumulate into ticks.
  let forwarding = false;
  let wheelAcc = 0;

  const cancelAnim = () => {
    if (raf !== null) {
      cancelAnimationFrame(raf);
      raf = null;
    }
    lastFrameTs = 0;
    scrollAcc = 0;
    expectedScrollTop = null;
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
    forwarding = !!opt.shouldForwardWheel?.();
    wheelAcc = 0;
  };

  const onTouchMove = (e: TouchEvent): void => {
    if (!tracking || e.touches.length !== 1) return;
    // Block native scroll so it cannot fight our scrollTop updates. We use
    // passive: false on the listener registration below to make this work.
    e.preventDefault();
    const t = e.touches[0]!;
    const now = performance.now();
    const dy = lastY - t.clientY; // positive = scroll down

    if (forwarding) {
      // App owns the content (alt-screen + mouse mode): translate the drag
      // into wheel ticks and let the app scroll itself. No local scrollTop.
      wheelAcc += dy;
      const { notches, direction, remainderPx } = dragToWheel(wheelAcc, opt.wheelPxPerNotch);
      if (notches > 0) {
        opt.onWheel?.(direction, notches, t.clientX, t.clientY);
        wheelAcc = remainderPx;
      }
      lastY = t.clientY;
      lastTs = now;
      return;
    }

    const dt = now - lastTs;

    if (dy !== 0) {
      const rh = opt.rowHeightPx?.() ?? 0;
      const nextPos = clampScroll(scrollEl.scrollTop + dy);
      // Align to row grid during drag if row height is known
      scrollEl.scrollTop = rh > 0 ? Math.round(nextPos / rh) * rh : nextPos;
    }

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
    if (forwarding) {
      // Forwarded scroll is 1:1 with the drag — no inertia fling (it would
      // spam send-keys to the app). Stop cleanly here.
      forwarding = false;
      wheelAcc = 0;
      return;
    }
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

      const rh = opt.rowHeightPx?.() ?? 0;
      // Row-aligned writes make xterm's realign a no-op (≤0.5px rounding), so
      // 1.5 rows cleanly separates it from genuine external jumps. Without a
      // known row height we can't quantize, so tolerate up to ~2-3 rows of
      // realign drift instead (the old 2px threshold killed every fling the
      // moment output arrived — see work folder findings 2026-07-05).
      const threshold = rh > 0 ? rh * 1.5 : 40;
      if (expectedScrollTop !== null
        && Math.abs(scrollEl.scrollTop - expectedScrollTop) > threshold) {
        cancelAnim();
        velocity = 0;
        return;
      }

      scrollAcc += velocity * frameDt;
      const unit = rh > 0 ? rh : 1;
      const steps = Math.trunc(scrollAcc / unit);
      if (steps !== 0) {
        const max = scrollEl.scrollHeight - scrollEl.clientHeight;
        const st = scrollEl.scrollTop;
        const next = rh > 0
          ? Math.round((Math.round(st / rh) + steps) * rh)
          : st + steps;
        if (max <= 0 || next <= 0 || next >= max) {
          scrollEl.scrollTop = clampScroll(next);
          expectedScrollTop = scrollEl.scrollTop;
          cancelAnim();
          velocity = 0;
          return;
        }
        scrollEl.scrollTop = next;
        expectedScrollTop = next;
        scrollAcc -= steps * unit;
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
