import { test, expect } from "bun:test";
import { SessionPeers } from "../../src/server/session-peers";

test("others lists the session's other peers only", () => {
  const p = new SessionPeers<string>();
  p.add("s", "a"); p.add("s", "b"); p.add("t", "c");
  expect(p.others("s", "a")).toEqual(["b"]);
  expect(p.others("s", "x")).toEqual(["a", "b"]);
  expect(p.others("u", "a")).toEqual([]);
});

test("remove reports whether the peer was the last pinner", () => {
  const p = new SessionPeers<string>();
  p.add("s", "a"); p.add("s", "b");
  p.pinned("s", "a"); p.pinned("s", "b");
  expect(p.remove("s", "a")).toBe(false);
  expect(p.remove("s", "b")).toBe(true);
  expect(p.remove("s", "b")).toBe(false);
  expect(p.size()).toBe(0);
});

test("a pinner that never joined (closed mid-attach) still clears on remove", () => {
  const p = new SessionPeers<string>();
  p.pinned("s", "a");
  expect(p.remove("s", "a")).toBe(true);
  expect(p.size()).toBe(0);
});


test("pin generations distinguish repeated pins by the same page and clear with peers", () => {
  const p = new SessionPeers<string>(); p.add("s", "a");
  p.pinned("s", "a"); const first = p.pinVersion("s");
  p.pinned("s", "a"); expect(p.pinVersion("s")).toBeGreaterThan(first);
  p.remove("s", "a"); expect(p.pinVersion("s")).toBe(0);
});
