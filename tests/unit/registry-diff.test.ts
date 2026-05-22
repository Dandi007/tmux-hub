import { describe, test, expect } from "bun:test";
import { diffSessions } from "../../src/server/session-registry";
import type { SessionInfo } from "../../src/shared/protocol";

const s = (name: string, activity = 0, attached = 0, windows = 1): SessionInfo => ({
  name,
  activity,
  attached,
  windows,
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
