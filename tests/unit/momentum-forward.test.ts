import { describe, test, expect } from "bun:test";
import { attachMomentumScroll } from "../../src/web/momentum-scroll";

// jsdom-free env: stub the rAF pair the local inertia path uses.
(globalThis as any).requestAnimationFrame ??= () => 0;
(globalThis as any).cancelAnimationFrame ??= () => {};

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

describe("attachMomentumScroll wheel forwarding", () => {
  test("forwards drag as wheel ticks when shouldForwardWheel is true", () => {
    const { el, fire } = fakeEl();
    const calls: Array<{ dir: string; notches: number }> = [];
    attachMomentumScroll(el, el, {
      shouldForwardWheel: () => true,
      wheelPxPerNotch: 10,
      onWheel: (dir, notches) => calls.push({ dir, notches }),
    });

    fire("touchstart", touch(100));
    // finger moves up 25px → dy=+25 → 2 ticks down, 5px retained
    fire("touchmove", touch(75));
    // finger moves up 5px more → retained 5 + 5 = 10 → 1 more tick down
    fire("touchmove", touch(70));
    fire("touchend", 0);

    expect(calls).toEqual([
      { dir: "down", notches: 2 },
      { dir: "down", notches: 1 },
    ]);
    // local scroll must be untouched on the forwarding path
    expect(el.scrollTop).toBe(0);
  });

  test("scrolls direction up when finger drags down", () => {
    const { el, fire } = fakeEl();
    const calls: Array<{ dir: string; notches: number }> = [];
    attachMomentumScroll(el, el, {
      shouldForwardWheel: () => true,
      wheelPxPerNotch: 10,
      onWheel: (dir, notches) => calls.push({ dir, notches }),
    });

    fire("touchstart", touch(100));
    fire("touchmove", touch(135)); // dy = -35 → 3 ticks up
    fire("touchend", 0);

    expect(calls).toEqual([{ dir: "up", notches: 3 }]);
  });

  test("does NOT forward when shouldForwardWheel is false (local scroll)", () => {
    const { el, fire } = fakeEl({ scrollHeight: 1000, clientHeight: 100 });
    const calls: unknown[] = [];
    attachMomentumScroll(el, el, {
      shouldForwardWheel: () => false,
      onWheel: () => calls.push(1),
    });

    fire("touchstart", touch(100));
    fire("touchmove", touch(70)); // dy=+30 → local scrollTop += 30
    fire("touchend", 0);

    expect(calls).toEqual([]);
    expect(el.scrollTop).toBe(30);
  });
});
