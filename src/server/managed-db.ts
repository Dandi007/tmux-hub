import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { createLogger } from "./logger";

const logger = createLogger("managed-db");

export class ManagedSessionDb {
  private db: Database;

  constructor(dbPath?: string) {
    const path = dbPath ?? resolve(homedir(), ".cache/tmux-hub/managed-sessions.db");
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

  all(): Set<string> {
    const rows = this.db.query("SELECT name FROM managed_sessions").all() as { name: string }[];
    return new Set(rows.map((r) => r.name));
  }

  close(): void {
    this.db.close();
  }
}
