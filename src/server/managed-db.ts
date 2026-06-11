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
  }

  rename(oldName: string, newName: string): void {
    this.db.run("UPDATE managed_sessions SET name = ? WHERE name = ?", [newName, oldName]);
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
