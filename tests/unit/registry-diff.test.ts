import { describe, test, expect } from "bun:test";
import { diffSessions, filterManagedSessions } from "../../src/server/session-registry";
import type { SessionInfo } from "../../src/shared/protocol";

const s = (name: string, activity = 0, attached = 0, windows = 1, cols = 80, rows = 24): SessionInfo => ({
  name,
  activity,
  attached,
  windows,
  cols,
  rows,
  grammar_ok: false,
});

describe("diffSessions", () => {
  test("detects created", () => {
    const events = diffSessions([], [s("a")]);
    expect(events).toEqual([{ event: "session_created", payload: s("a") }]);
  });

  test("detects removed", () => {
    const events = diffSessions([s("a")], []);
    expect(events).toEqual([{ event: "session_removed", payload: { name: "a" } }]);
  });

  test("detects activity change only", () => {
    const events = diffSessions([s("a", 100)], [s("a", 200)]);
    expect(events).toEqual([{ event: "session_activity", payload: s("a", 200) }]);
  });

  test("detects attached change", () => {
    const events = diffSessions([s("a", 100, 0)], [s("a", 100, 1)]);
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe("session_activity");
  });

  test("ignores no-op", () => {
    const events = diffSessions([s("a", 100)], [s("a", 100)]);
    expect(events).toEqual([]);
  });

  test("combined create + remove + activity", () => {
    const prev = [s("a", 100), s("b", 100)];
    const next = [s("a", 200), s("c", 50)];
    const events = diffSessions(prev, next);
    expect(events).toHaveLength(3);
    const kinds = events.map((e) => e.event).sort();
    expect(kinds).toEqual(["session_activity", "session_created", "session_removed"]);
  });
});

describe("filterManagedSessions", () => {
  test("keeps only sessions present in the managed set", () => {
    const all = [s("hub-a"), s("private-b"), s("hub-c")];
    const managed = new Set(["hub-a", "hub-c"]);
    expect(filterManagedSessions(all, managed).map((x) => x.name)).toEqual(["hub-a", "hub-c"]);
  });

  test("empty managed set hides every session", () => {
    const all = [s("a"), s("b")];
    expect(filterManagedSessions(all, new Set())).toEqual([]);
  });

  test("managed name with no live session simply does not appear (intersection)", () => {
    const all = [s("alive")];
    const managed = new Set(["alive", "dead-but-still-in-db"]);
    expect(filterManagedSessions(all, managed).map((x) => x.name)).toEqual(["alive"]);
  });

  test("preserves order and SessionInfo payloads of the input list", () => {
    const all = [s("b", 200, 1), s("a", 100, 0)];
    const managed = new Set(["a", "b"]);
    expect(filterManagedSessions(all, managed)).toEqual(all);
  });
});
