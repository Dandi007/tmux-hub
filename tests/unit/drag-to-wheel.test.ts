import { describe, test, expect } from "bun:test";
import { dragToWheel } from "../../src/web/momentum-scroll";

describe("dragToWheel", () => {
  test("positive accumulated drag scrolls down", () => {
    const r = dragToWheel(25, 10);
    expect(r.direction).toBe("down");
    expect(r.notches).toBe(2);
    expect(r.remainderPx).toBeCloseTo(5);
  });

  test("negative accumulated drag scrolls up", () => {
    const r = dragToWheel(-25, 10);
    expect(r.direction).toBe("up");
    expect(r.notches).toBe(2);
    expect(r.remainderPx).toBeCloseTo(-5);
  });

  test("sub-notch movement emits nothing and is fully retained", () => {
    const r = dragToWheel(6, 10);
    expect(r.notches).toBe(0);
    expect(r.remainderPx).toBeCloseTo(6);
  });

  test("exact multiples leave no remainder", () => {
    const r = dragToWheel(30, 10);
    expect(r.notches).toBe(3);
    expect(r.remainderPx).toBeCloseTo(0);
  });

  test("guards against non-positive pxPerNotch", () => {
    const r = dragToWheel(50, 0);
    expect(r.notches).toBe(0);
    expect(r.remainderPx).toBeCloseTo(50);
  });
});
