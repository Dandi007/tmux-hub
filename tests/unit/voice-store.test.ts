import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { VoiceStore } from "../../src/server/voice-store";

let dir: string;
let store: VoiceStore;

beforeEach(() => {
  dir = mkdtempSync("/tmp/tht-voice-");
  store = new VoiceStore(join(dir, "voice.db"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("VoiceStore", () => {
  test("add then listByUid returns the row", () => {
    store.add({ uid: "u1", text: "你好", audioBlobId: "B1", mime: "audio/mp4", bytes: 1234 });
    const rows = store.listByUid("u1");
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ text: "你好", audio_blob_id: "B1", mime: "audio/mp4", bytes: 1234 });
    expect(typeof rows[0].id).toBe("number");
    expect(typeof rows[0].created_at).toBe("string");
  });

  test("listByUid is scoped per uid (no cross-user leak)", () => {
    store.add({ uid: "u1", text: "mine", audioBlobId: "B1", mime: "audio/mp4", bytes: 1 });
    store.add({ uid: "u2", text: "theirs", audioBlobId: "B2", mime: "audio/mp4", bytes: 2 });
    expect(store.listByUid("u1").map((r) => r.text)).toEqual(["mine"]);
    expect(store.listByUid("u2").map((r) => r.text)).toEqual(["theirs"]);
    expect(store.listByUid("nobody")).toEqual([]);
  });

  test("listByUid newest first, honors limit", () => {
    for (let i = 0; i < 5; i++) store.add({ uid: "u1", text: `t${i}`, audioBlobId: `B${i}`, mime: "audio/mp4", bytes: i });
    const rows = store.listByUid("u1", 3);
    expect(rows.length).toBe(3);
    // newest (highest id) first
    expect(rows[0].text).toBe("t4");
    expect(rows[2].text).toBe("t2");
  });

  test("audio with null blob_id (clean stored but blob missing) is allowed", () => {
    store.add({ uid: "u1", text: "no audio", audioBlobId: null, mime: null, bytes: null });
    const rows = store.listByUid("u1");
    expect(rows[0].audio_blob_id).toBeNull();
  });

  test("findOwnedBlob: returns mime only for the owner's blob, else null", () => {
    store.add({ uid: "u1", text: "x", audioBlobId: "BLOB-A", mime: "audio/mp4", bytes: 1 });
    store.add({ uid: "u2", text: "y", audioBlobId: "BLOB-B", mime: "audio/webm", bytes: 1 });
    expect(store.findOwnedBlob("u1", "BLOB-A")).toEqual({ mime: "audio/mp4" });
    expect(store.findOwnedBlob("u1", "BLOB-B")).toBeNull(); // not u1's
    expect(store.findOwnedBlob("u2", "BLOB-B")).toEqual({ mime: "audio/webm" });
    expect(store.findOwnedBlob("u1", "NONEXISTENT")).toBeNull();
  });

  test("stores raw_text / card / degraded alongside the polished text", () => {
    store.add({
      uid: "u1", text: "整理后的文本", rawText: "呃那个原始的转写", card: "hub-polish",
      degraded: null, audioBlobId: "B1", mime: "audio/mp4", bytes: 1,
    });
    expect(store.listByUid("u1")[0]).toMatchObject({
      text: "整理后的文本", raw_text: "呃那个原始的转写", card: "hub-polish", degraded: null,
    });
  });

  test("degraded rows record why the polish was rolled back", () => {
    store.add({
      uid: "u1", text: "原文", rawText: "原文", card: "hub-polish",
      degraded: "guard_expanded", audioBlobId: "B1", mime: "audio/mp4", bytes: 1,
    });
    expect(store.listByUid("u1")[0].degraded).toBe("guard_expanded");
  });

  test("new columns default to null (back-compat with pre-migration callers)", () => {
    store.add({ uid: "u1", text: "只有文本", audioBlobId: null, mime: null, bytes: null });
    expect(store.listByUid("u1")[0]).toMatchObject({ raw_text: null, card: null, degraded: null });
  });

  test("migrates an existing pre-migration table without losing rows", () => {
    const path = join(dir, "legacy.db");
    // 复刻迁移前的建表语句 + 一行老数据。
    const legacy = new Database(path);
    legacy.run(`
      CREATE TABLE voice_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT NOT NULL,
        text TEXT NOT NULL,
        audio_blob_id TEXT,
        mime TEXT,
        bytes INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    legacy.run("INSERT INTO voice_log (uid, text, audio_blob_id, mime, bytes) VALUES ('u1','老记录','B0','audio/mp4',9)");
    legacy.close();

    const migrated = new VoiceStore(path);
    const rows = migrated.listByUid("u1");
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ text: "老记录", raw_text: null, card: null, degraded: null });
    // 迁移幂等：再开一次不该抛（ALTER TABLE 不能重复执行）。
    migrated.close();
    const again = new VoiceStore(path);
    expect(again.listByUid("u1").length).toBe(1);
    again.close();
  });

  test("persists across reopen (same db file)", () => {
    store.add({ uid: "u1", text: "persisted", audioBlobId: "B1", mime: "audio/mp4", bytes: 1 });
    const path = join(dir, "voice.db");
    store.close();
    const reopened = new VoiceStore(path);
    expect(reopened.listByUid("u1").map((r) => r.text)).toEqual(["persisted"]);
    reopened.close();
    store = new VoiceStore(path); // so afterEach close() is valid
  });
});
