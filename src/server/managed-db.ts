import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { createLogger } from "./logger";

const logger = createLogger("managed-db");

/** Default managed-sessions db location, honoring TMUX_HUB_DB_PATH. */
export function managedDbPath(dbPath?: string): string {
  return dbPath ?? process.env.TMUX_HUB_DB_PATH ?? resolve(homedir(), ".cache/tmux-hub/managed-sessions.db");
}

/**
 * Read the set of managed session names without the side effects of the full
 * ManagedSessionDb (no mkdir, no CREATE TABLE, no logging) — for read-only
 * consumers like the `tmux-hub tui` CLI that must not pollute user-facing
 * output. Returns an empty set if the db file or table does not exist yet
 * (meaning: nothing is managed).
 */
export function readManagedNames(dbPath?: string): Set<string> {
  const path = managedDbPath(dbPath);
  if (!existsSync(path)) return new Set();
  const db = new Database(path, { readonly: true });
  try {
    const rows = db.query("SELECT name FROM managed_sessions").all() as { name: string }[];
    return new Set(rows.map((r) => r.name));
  } catch {
    // Table not created yet (fresh db touched by something else) → nothing managed.
    return new Set();
  } finally {
    db.close();
  }
}

export class ManagedSessionDb {
  private db: Database;

  constructor(dbPath?: string) {
    const path = managedDbPath(dbPath);
    mkdirSync(resolve(path, ".."), { recursive: true });
    this.db = new Database(path);
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS managed_sessions (
        name TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        template_id TEXT
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS scroll_positions (
        name TEXT PRIMARY KEY,
        lines_from_bottom INTEGER NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    logger.info({ path }, "managed sessions db opened");
  }

  add(name: string, templateId?: string): void {
    this.db.run(
      "INSERT OR IGNORE INTO managed_sessions (name, template_id) VALUES (?, ?)",
      [name, templateId ?? null],
    );
  }

  remove(name: string): void {
    this.db.run("DELETE FROM managed_sessions WHERE name = ?", [name]);
    this.db.run("DELETE FROM scroll_positions WHERE name = ?", [name]);
  }

  rename(oldName: string, newName: string): void {
    this.db.run("UPDATE managed_sessions SET name = ? WHERE name = ?", [newName, oldName]);
    // Stale row from an out-of-band killed session must not block rename.
    this.db.run("DELETE FROM scroll_positions WHERE name = ?", [newName]);
    this.db.run("UPDATE scroll_positions SET name = ? WHERE name = ?", [newName, oldName]);
  }

  setScrollPos(name: string, linesFromBottom: number): void {
    this.db.run(
      "INSERT INTO scroll_positions (name, lines_from_bottom, updated_at) VALUES (?, ?, datetime('now')) " +
      "ON CONFLICT(name) DO UPDATE SET lines_from_bottom = excluded.lines_from_bottom, updated_at = excluded.updated_at",
      [name, linesFromBottom],
    );
  }

  getScrollPos(name: string): number | null {
    const row = this.db.query("SELECT lines_from_bottom FROM scroll_positions WHERE name = ?").get(name) as { lines_from_bottom: number } | null;
    return row ? row.lines_from_bottom : null;
  }

  has(name: string): boolean {
    return this.db.query("SELECT 1 FROM managed_sessions WHERE name = ?").get(name) !== null;
  }

  adhocNames(): string[] {
    const rows = this.db.query("SELECT name FROM managed_sessions WHERE template_id IS NULL").all() as { name: string }[];
    return rows.map((r) => r.name);
  }

  all(): Set<string> {
    const rows = this.db.query("SELECT name FROM managed_sessions").all() as { name: string }[];
    return new Set(rows.map((r) => r.name));
  }

  close(): void {
    this.db.close();
  }
}
