import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ManagedSessionDb, readManagedNames } from "../../src/server/managed-db";

const TMP = mkdtempSync("/tmp/tht-mdb-");

function dbPath() {
  return join(TMP, `test-${Math.random().toString(36).slice(2, 8)}.db`);
}

afterAll(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
});

describe("ManagedSessionDb.adhocNames", () => {
  test("returns empty when no sessions", () => {
    const db = new ManagedSessionDb(dbPath());
    expect(db.adhocNames()).toEqual([]);
    db.close();
  });

  test("returns only ad-hoc sessions (template_id IS NULL)", () => {
    const db = new ManagedSessionDb(dbPath());
    db.add("shell-20260530120000", "shell");
    db.add("adhoc-20260530120001");           // no templateId → NULL
    db.add("adhoc-20260530120002");           // no templateId → NULL
    db.add("pipeline-20260530120003", "pipeline");

    const names = db.adhocNames();
    expect(names.sort()).toEqual(["adhoc-20260530120001", "adhoc-20260530120002"]);
    db.close();
  });

  test("returns empty when all sessions have template_id", () => {
    const db = new ManagedSessionDb(dbPath());
    db.add("shell-20260530120000", "shell");
    db.add("pipeline-20260530120001", "pipeline");

    expect(db.adhocNames()).toEqual([]);
    db.close();
  });

  test("removed ad-hoc session no longer appears", () => {
    const db = new ManagedSessionDb(dbPath());
    db.add("adhoc-20260530120001"); // no templateId → NULL
    expect(db.adhocNames()).toEqual(["adhoc-20260530120001"]);
    db.remove("adhoc-20260530120001");
    expect(db.adhocNames()).toEqual([]);
    db.close();
  });
});

describe("readManagedNames", () => {
  test("returns the names a ManagedSessionDb has written", () => {
    const path = dbPath();
    const db = new ManagedSessionDb(path);
    db.add("shell-20260611120000", "shell");
    db.add("adhoc-20260611120001");
    db.close();

    const names = readManagedNames(path);
    expect(names.has("shell-20260611120000")).toBe(true);
    expect(names.has("adhoc-20260611120001")).toBe(true);
    expect(names.size).toBe(2);
  });

  test("does not include names that were never registered", () => {
    const path = dbPath();
    const db = new ManagedSessionDb(path);
    db.add("managed-1", "shell");
    db.close();

    const names = readManagedNames(path);
    expect(names.has("managed-1")).toBe(true);
    expect(names.has("some-private-tmux-session")).toBe(false);
  });

  test("returns empty set when the db file does not exist", () => {
    const names = readManagedNames(join(TMP, "does-not-exist.db"));
    expect(names.size).toBe(0);
  });
});

describe("scroll positions", () => {
  test("set/get roundtrip and default null", () => {
    const db = new ManagedSessionDb(dbPath());
    expect(db.getScrollPos("s1")).toBeNull();
    db.setScrollPos("s1", 123);
    expect(db.getScrollPos("s1")).toBe(123);
    db.setScrollPos("s1", 7); // upsert
    expect(db.getScrollPos("s1")).toBe(7);
    db.close();
  });

  test("remove(name) cascades scroll position", () => {
    const db = new ManagedSessionDb(dbPath());
    db.add("s2");
    db.setScrollPos("s2", 42);
    db.remove("s2");
    expect(db.getScrollPos("s2")).toBeNull();
    db.close();
  });

  test("rename(old, new) migrates scroll position", () => {
    const db = new ManagedSessionDb(dbPath());
    db.add("r1");
    db.setScrollPos("r1", 55);
    db.rename("r1", "r2");
    expect(db.getScrollPos("r2")).toBe(55);
    expect(db.getScrollPos("r1")).toBeNull();
    db.close();
  });
});
