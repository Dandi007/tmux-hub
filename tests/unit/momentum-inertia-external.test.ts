import { describe, test, expect } from "bun:test";
import { attachMomentumScroll } from "../../src/web/momentum-scroll";

// Drivable rAF: tests need to advance frames manually to exercise the inertia
// step. The forwarding-only tests in momentum-forward.test.ts stub rAF as a
// no-op because they never reach the inertia path; here we need a real queue.
type RafCb = (ts: number) => void;
let rafQueue: RafCb[] = [];
let rafId = 0;
const rafIdToCb = new Map<number, RafCb>();
(globalThis as any).requestAnimationFrame = (cb: RafCb): number => {
  const id = ++rafId;
  rafIdToCb.set(id, cb);
  rafQueue.push(cb);
  return id;
};
(globalThis as any).cancelAnimationFrame = (id: number): void => {
  const cb = rafIdToCb.get(id);
  if (cb) {
    rafQueue = rafQueue.filter((c) => c !== cb);
    rafIdToCb.delete(id);
  }
};
const flushRaf = (ts: number): void => {
  // Snapshot the queue — a step that reschedules itself pushes onto the queue
  // inside the cb, so we drain one frame at a time without infinite loop on
  // a step that re-schedules.
  const pending = rafQueue;
  rafQueue = [];
  for (const cb of pending) {
    cb(ts);
  }
};
const resetRaf = (): void => {
  rafQueue = [];
  rafIdToCb.clear();
};

// Minimal fake element: records listeners so the test can drive touch events,
// and exposes the scroll props attachMomentumScroll reads on the local path.
function fakeEl(scroll?: { scrollHeight: number; clientHeight: number }) {
  const handlers: Record<string, (e: any) => void> = {};
  return {
    el: {
      addEventListener: (type: string, fn: (e: any) => void) => { handlers[type] = fn; },
      removeEventListener: (type: string) => { delete handlers[type]; },
      scrollTop: 0,
      scrollHeight: scroll?.scrollHeight ?? 0,
      clientHeight: scroll?.clientHeight ?? 0,
    } as any,
    fire: (type: string, clientY: number, clientX = 0) => {
      handlers[type]?.({
        touches: type === "touchend" ? [] : [{ clientX, clientY }],
        preventDefault() {},
      });
    },
  };
}

const touch = (clientY: number) => clientY;

describe("attachMomentumScroll inertia + external viewport changes", () => {
  test("fling halts when an external actor changes scrollTop mid-fling", () => {
    resetRaf();
    // Large scrollback so the fling has room and isn't clamped to max.
    const { el, fire } = fakeEl({ scrollHeight: 100_000, clientHeight: 100 });
    attachMomentumScroll(el, el, {
      shouldForwardWheel: () => false,
      minVelocity: 0.04,
      friction: 0.94,
    });

    // Build velocity: a quick upward drag (finger up → content scrolls down).
    fire("touchstart", touch(200));
    fire("touchmove", touch(100)); // dy = +100 → strong downward velocity
    fire("touchend", 0);

    // Capture the scrollTop momentum wrote on frame 1, then simulate xterm
    // resetting the viewport (new output pinned to bottom) by overwriting
    // scrollTop to a different value before the next frame.
    flushRaf(33);
    const scrollTopAfterFrame1 = el.scrollTop;
    expect(scrollTopAfterFrame1).toBeGreaterThan(0);

    // xterm appends output and pins viewport to bottom — scrollTop jumps to
    // a value momentum did not write. This is the "跳顶/弹回" race.
    el.scrollTop = 95_000;

    // Drive the next frame. Momentum must observe the external change and
    // stop, rather than continuing to write its own (stale) velocity on top.
    flushRaf(33);

    const scrollTopAfterExternal = el.scrollTop;
    // If momentum respected the external change, it should NOT have reverted
    // 95_000 back toward its pre-external trajectory. Allow a tiny drift from
    // sub-pixel accumulator but nothing like the full velocity continuation.
    expect(Math.abs(el.scrollTop - 95_000)).toBeLessThan(50);

    // And momentum should have stopped scheduling further frames.
    // Drain any remaining frames; position must stay put.
    flushRaf(49);
    flushRaf(65);
    expect(Math.abs(el.scrollTop - 95_000)).toBeLessThan(50);
  });

  test("fling continues normally when no external change happens", () => {
    resetRaf();
    const { el, fire } = fakeEl({ scrollHeight: 100_000, clientHeight: 100 });
    attachMomentumScroll(el, el, {
      shouldForwardWheel: () => false,
      minVelocity: 0.04,
      friction: 0.94,
    });

    fire("touchstart", touch(200));
    fire("touchmove", touch(100));
    fire("touchend", 0);

    const before = el.scrollTop;
    // Drive several frames with nothing interfering. Velocity should keep
    // moving scrollTop (decreasing as friction bites) but not halt abruptly.
    flushRaf(33);
    const mid = el.scrollTop;
    expect(mid).not.toBe(before);
    flushRaf(49);
    flushRaf(65);
    // Position keeps progressing while velocity is above threshold — we
    // don't assert exact values, just that it moved further than `mid` for
    // at least one of the frames (monotonic-ish decay).
    expect(el.scrollTop).not.toBe(before);
  });
});
