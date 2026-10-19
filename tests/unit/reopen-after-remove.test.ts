import { test, expect } from "bun:test";
import { ReopenAfterRemove } from "../../src/web/reopen-after-remove";

test("a same-name recreate within the window reopens once", () => {
  let t = 0;
  const r = new ReopenAfterRemove(() => t, 1000);
  r.removed("x");
  t = 500;
  expect(r.take("y")).toBe(false);
  expect(r.take("x")).toBe(true);
  expect(r.take("x")).toBe(false);
});

test("a recreate after the window does not reopen", () => {
  let t = 0;
  const r = new ReopenAfterRemove(() => t, 1000);
  r.removed("x");
  t = 1001;
  expect(r.take("x")).toBe(false);
});

test("opening another session cancels the reopen", () => {
  const r = new ReopenAfterRemove(() => 0, 1000);
  r.removed("x");
  r.cancel();
  expect(r.take("x")).toBe(false);
});
