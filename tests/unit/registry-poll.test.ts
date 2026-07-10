// tests/unit/registry-poll.test.ts
// Defensive poll() semantics for SessionRegistry (2026-07-10 incident):
//  1. A live tmux session whose managed row vanished externally must be
//     re-adopted, not cascaded into session_removed + replay-log deletion.
//  2. A managed session missing from tmux is only removed after
//     REMOVAL_CONFIRM_POLLS consecutive misses (transient glitches must not
//     destroy state), and a reappearance resets the streak.
import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRegistry, REMOVAL_CONFIRM_POLLS } from "../../src/server/session-registry";
import { ManagedSessionDb } from "../../src/server/managed-db";
import type { SessionInfo, ServerEvent } from "../../src/shared/protocol";

function info(name: string): SessionInfo {
  return { name, activity: 1, attached: 0, windows: 1, cols: 80, rows: 24, grammar_ok: true, pane_title: "" };
}

function build(ref: { sessions: SessionInfo[] | null }) {
  const db = new ManagedSessionDb(join(mkdtempSync(join(tmpdir(), "reg-poll-")), "db.sqlite"));
  const registry = new SessionRegistry(db, async () => ref.sessions);
  const events: ServerEvent[] = [];
  registry.subscribe((e) => events.push(e));
  return { db, registry, events };
}

const removedEvents = (events: ServerEvent[]) => events.filter((e) => e.event === "session_removed");

describe("SessionRegistry.poll defenses", () => {
  test("re-adopts a live session whose managed row vanished externally", async () => {
    const ref = { sessions: [info("s1")] };
    const { db, registry, events } = build(ref);
    db.add("s1");
    await registry.pollNow();
    expect(events.filter((e) => e.event === "session_created")).toHaveLength(1);

    // External wipe of the managed row while the tmux session is alive.
    db.remove("s1");
    await registry.pollNow();

    expect(removedEvents(events)).toHaveLength(0);
    expect(db.all().has("s1")).toBe(true);
    expect(registry.snapshot().map((s) => s.name)).toEqual(["s1"]);
  });

  test("removes a session missing from tmux only after N consecutive misses", async () => {
    const ref: { sessions: SessionInfo[] | null } = { sessions: [info("s1")] };
    const { db, registry, events } = build(ref);
    db.add("s1");
    await registry.pollNow();

    ref.sessions = [];
    for (let i = 1; i < REMOVAL_CONFIRM_POLLS; i += 1) {
      await registry.pollNow();
      expect(removedEvents(events)).toHaveLength(0);
      expect(db.all().has("s1")).toBe(true);
      expect(registry.snapshot().map((s) => s.name)).toEqual(["s1"]);
    }

    await registry.pollNow(); // Nth consecutive miss → confirmed removal
    expect(removedEvents(events)).toHaveLength(1);
    expect(db.all().has("s1")).toBe(false);
    expect(registry.snapshot()).toHaveLength(0);
  });

  test("a reappearing session resets the missing streak", async () => {
    const ref: { sessions: SessionInfo[] | null } = { sessions: [info("s1")] };
    const { db, registry, events } = build(ref);
    db.add("s1");
    await registry.pollNow();

    ref.sessions = [];
    for (let i = 1; i < REMOVAL_CONFIRM_POLLS; i += 1) await registry.pollNow();
    ref.sessions = [info("s1")]; // back alive before confirmation
    await registry.pollNow();
    expect(removedEvents(events)).toHaveLength(0);

    ref.sessions = [];
    for (let i = 1; i < REMOVAL_CONFIRM_POLLS; i += 1) {
      await registry.pollNow();
      expect(removedEvents(events)).toHaveLength(0);
    }
    await registry.pollNow();
    expect(removedEvents(events)).toHaveLength(1);
  });
});
