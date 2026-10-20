import { test, expect } from "bun:test";
import { ReplayProgress } from "../../src/web/replay-progress";

test("replay observation starts pending and follows sequential parse barriers", () => {
  const p = new ReplayProgress();
  expect(p.pending).toBe(true);
  p.complete(p.generation); expect(p.pending).toBe(false);
  p.begin(); expect(p.pending).toBe(true);
  p.complete(p.generation); expect(p.pending).toBe(false);
});

test("old queued completion cannot declare a newer replay parsed", () => {
  const p = new ReplayProgress(), first = p.generation;
  const completeOld = () => p.complete(first);
  p.begin(); const second = p.generation;
  completeOld(); expect(p.pending).toBe(true);
  p.complete(second); expect(p.pending).toBe(false);
  completeOld(); expect(p.pending).toBe(false);
});

test("abandoned replay and stale completion do not block the latest replay", () => {
  const p = new ReplayProgress();
  p.begin(); const abandoned = p.generation;
  p.begin(); const latest = p.generation;
  p.complete(abandoned); expect(p.pending).toBe(true);
  p.complete(latest); expect(p.pending).toBe(false);
});
