import { test, expect } from "bun:test";
import { ScrollIntentTracker } from "../../src/web/scroll-intent";
const normal = (baseY: number, viewportY: number) => ({ type: "normal" as const, baseY, viewportY });

test("actual history navigation and return-to-bottom replace the remembered intent", () => {
  const t = new ScrollIntentTracker();
  expect(t.observe(normal(400, 400), true)).toBeNull();
  expect(t.observe(normal(400, 340), true)).toBe(60);
  expect(t.observe(normal(400, 400), true)).toBe(0);
});
test("RIS and replay history rebuilding do not become a new scroll intent", () => {
  const t = new ScrollIntentTracker();
  t.observe(normal(400, 340), true);
  expect(t.observe(normal(0, 0), true)).toBeNull();
  expect(t.observe(normal(200, 200), true)).toBeNull();
  expect(t.observe(normal(400, 400), true)).toBeNull();
  expect(t.observe(normal(400, 340), true)).toBe(60);
});
test("programmatic restoration updates the baseline without replacing intent", () => {
  const t = new ScrollIntentTracker();
  t.observe(normal(400, 340), true);
  expect(t.observe(normal(400, 400), false)).toBeNull();
  expect(t.observe(normal(400, 340), false)).toBeNull();
  expect(t.observe(normal(400, 340), true)).toBeNull();
  expect(t.observe(normal(400, 400), true)).toBe(0);
});
test("hidden or not-yet-ready samples never become user intent", () => {
  const t = new ScrollIntentTracker();
  t.observe(normal(400, 400), false);
  expect(t.observe(normal(400, 37), false)).toBeNull();
  expect(t.observe(normal(400, 37), true)).toBeNull();
});
test("alternate buffer and resize origin changes do not create user intent", () => {
  const t = new ScrollIntentTracker();
  t.observe(normal(400, 340), true);
  expect(t.observe({ type: "alternate", baseY: 0, viewportY: 0 }, true)).toBeNull();
  expect(t.observe(normal(400, 340), false)).toBeNull();
  expect(t.observe(normal(420, 350), true)).toBeNull();
});
