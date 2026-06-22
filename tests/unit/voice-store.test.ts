import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
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
