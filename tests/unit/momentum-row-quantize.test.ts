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

describe("momentum row quantization", () => {
  test("with rowHeightPx, all inertia writes are row-aligned", () => {
    resetRaf();
    const { el, fire } = fakeEl({ scrollHeight: 100_000, clientHeight: 100 });
    const writes: number[] = [];
    // 用 defineProperty 记录每次 scrollTop 写入
    let _st = 0;
    Object.defineProperty(el, "scrollTop", {
      get: () => _st,
      set: (v: number) => { _st = v; writes.push(v); },
    });
    attachMomentumScroll(el, el, { shouldForwardWheel: () => false, rowHeightPx: () => 15 });
    fire("touchstart", 200); fire("touchmove", 100); fire("touchend", 0);
    flushRaf(33); flushRaf(49); flushRaf(65); flushRaf(81);
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes.filter((v) => v > 0)) {
      expect(Math.abs(w - Math.round(w / 15) * 15)).toBeLessThanOrEqual(0.5);
    }
  });

  test("xterm sub-pixel realign (<1px) does NOT cancel the fling", () => {
    resetRaf();
    const { el, fire } = fakeEl({ scrollHeight: 100_000, clientHeight: 100 });
    attachMomentumScroll(el, el, { shouldForwardWheel: () => false, rowHeightPx: () => 15 });
    fire("touchstart", 200); fire("touchmove", 100); fire("touchend", 0);
    flushRaf(33);
    const afterF1 = el.scrollTop;
    // 模拟 xterm _innerRefresh：写回同一行的分数值（ydisp*rowHeight）
    el.scrollTop = afterF1 + 0.4;
    flushRaf(49);
    // fling 存活：位置继续按惯性推进，而不是停在 afterF1 附近
    flushRaf(65); flushRaf(81);
    expect(el.scrollTop).toBeGreaterThan(afterF1 + 15);
  });

  test("genuine external jump (many rows) still cancels", () => {
    resetRaf();
    const { el, fire } = fakeEl({ scrollHeight: 100_000, clientHeight: 100 });
    attachMomentumScroll(el, el, { shouldForwardWheel: () => false, rowHeightPx: () => 15 });
    fire("touchstart", 200); fire("touchmove", 100); fire("touchend", 0);
    flushRaf(33);
    el.scrollTop = 95_000; // 外部大跳变（如 replay 重置）
    flushRaf(49); flushRaf(65); flushRaf(81);
    expect(Math.abs(el.scrollTop - 95_000)).toBeLessThan(50);
  });

  test("without rowHeightPx, tolerance is 40px (a ~30px nudge survives)", () => {
    resetRaf();
    const { el, fire } = fakeEl({ scrollHeight: 100_000, clientHeight: 100 });
    attachMomentumScroll(el, el, { shouldForwardWheel: () => false });
    fire("touchstart", 200); fire("touchmove", 100); fire("touchend", 0);
    flushRaf(33);
    const afterF1 = el.scrollTop;
    el.scrollTop = afterF1 + 30; // < 40 → 不取消
    flushRaf(49); flushRaf(65); flushRaf(81);
    expect(el.scrollTop).toBeGreaterThan(afterF1 + 45);
  });
});
