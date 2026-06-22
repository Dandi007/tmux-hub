// 按账号保存语音记录：转写文本 + 原始音频（mp-blob 的 blob_id 引用）+ 元数据。
// 与 managed-db（会话管理、~/.cache）分离：语音是用户内容，落持久目录 ~/.local/share。
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { createLogger } from "./logger";

const logger = createLogger("voice-store");

/** 语音库路径，可由 TMUX_HUB_VOICE_DB_PATH 覆盖。 */
export function voiceDbPath(dbPath?: string): string {
  return dbPath ?? process.env.TMUX_HUB_VOICE_DB_PATH ??
    resolve(homedir(), ".local/share/tmux-hub/voice.db");
}

export interface VoiceRecord {
  id: number;
  text: string;
  audio_blob_id: string | null;
  mime: string | null;
  bytes: number | null;
  created_at: string;
}

export interface VoiceAdd {
  uid: string;
  text: string;
  audioBlobId: string | null;
  mime: string | null;
  bytes: number | null;
}

export class VoiceStore {
  private db: Database;

  constructor(dbPath?: string) {
    const path = voiceDbPath(dbPath);
    mkdirSync(resolve(path, ".."), { recursive: true });
    this.db = new Database(path);
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS voice_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT NOT NULL,
        text TEXT NOT NULL,
        audio_blob_id TEXT,
        mime TEXT,
        bytes INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_voice_uid_created ON voice_log(uid, id DESC)");
    logger.info({ path }, "voice store opened");
  }

  add(rec: VoiceAdd): void {
    this.db.run(
      "INSERT INTO voice_log (uid, text, audio_blob_id, mime, bytes) VALUES (?, ?, ?, ?, ?)",
      [rec.uid, rec.text, rec.audioBlobId, rec.mime, rec.bytes],
    );
  }

  /** 某用户的最近记录，新到旧，默认 50 条。 */
  listByUid(uid: string, limit = 50): VoiceRecord[] {
    return this.db
      .query("SELECT id, text, audio_blob_id, mime, bytes, created_at FROM voice_log WHERE uid = ? ORDER BY id DESC LIMIT ?")
      .all(uid, limit) as VoiceRecord[];
  }

  /**
   * 该 blob 是否属于该用户的某条记录；属于则返回其 mime（可能为 null），否则返回 null。
   * 音频回放用：既做越权鉴权（防取任意 blob），又取回 mime 设 Content-Type。
   */
  findOwnedBlob(uid: string, blobId: string): { mime: string | null } | null {
    const row = this.db
      .query("SELECT mime FROM voice_log WHERE uid = ? AND audio_blob_id = ? LIMIT 1")
      .get(uid, blobId) as { mime: string | null } | null;
    return row ?? null;
  }

  close(): void {
    this.db.close();
  }
}
