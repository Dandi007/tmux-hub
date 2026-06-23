import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { buildVoiceRoutes, type VoiceRouteDeps, type VoiceRecordRow } from "../../src/server/voice-routes";

// In-memory fake store mirroring VoiceStore's contract.
function fakeStore() {
  const rows: Array<VoiceRecordRow & { uid: string }> = [];
  let nextId = 1;
  return {
    rows,
    add(rec: { uid: string; text: string; audioBlobId: string | null; mime: string | null; bytes: number | null }) {
      rows.push({ id: nextId++, uid: rec.uid, text: rec.text, audio_blob_id: rec.audioBlobId, mime: rec.mime, bytes: rec.bytes, created_at: "2026-06-23T00:00:00Z" });
    },
    listByUid(uid: string, limit = 50): VoiceRecordRow[] {
      return rows.filter((r) => r.uid === uid).reverse().slice(0, limit);
    },
    findOwnedBlob(uid: string, blobId: string) {
      const r = rows.find((x) => x.uid === uid && x.audio_blob_id === blobId);
      return r ? { mime: r.mime } : null;
    },
  };
}

// /api/voice 现转发 voice-intake 的 SSE；持久化在 done 事件（流被读完时）旁路触发。
function sse(events: string): Response {
  return new Response(new TextEncoder().encode(events), { status: 200, headers: { "content-type": "text/event-stream" } });
}
const doneEvent = (text: string, blob = "blob://B1") =>
  `event: done\ndata: ${JSON.stringify({ text, raw_text: text, audio_blob_id: blob, t: { transcribeMs: 1, cleanMs: 1, totalMs: 2 } })}\n\n`;

// identity required (no default — passing explicit `undefined` must NOT be
// swallowed by a default value; that's the "anonymous" case under test).
function makeApp(deps: VoiceRouteDeps, identity: string | undefined) {
  const app = new Hono();
  app.use("*", async (c, next) => { if (identity !== undefined) c.set("identity", identity); await next(); });
  app.route("/", buildVoiceRoutes(deps));
  return app;
}

const baseDeps = (over: Partial<VoiceRouteDeps> = {}): VoiceRouteDeps => ({
  enabled: true,
  intake: async () => sse(doneEvent("整理后的文本")),
  ...over,
});

const audioBytes = () => new Uint8Array(2000); // > 1000 min

// 触发持久化必须读完转发的 SSE 流（onDone 在 pull 解析 done 时调用）。
async function drain(r: Response): Promise<void> { await r.text(); }

describe("buildVoiceRoutes · POST /api/voice persistence", () => {
  test("with store + identity → persists one row (done.text) and转发 SSE", async () => {
    const store = fakeStore();
    const app = makeApp(baseDeps({ store }), "user-1");
    const r = await app.fetch(new Request("http://x/api/voice", { method: "POST", headers: { "content-type": "audio/mp4" }, body: audioBytes() }));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    await drain(r);
    expect(store.rows.length).toBe(1);
    expect(store.rows[0]).toMatchObject({ uid: "user-1", text: "整理后的文本", audio_blob_id: "blob://B1", mime: "audio/mp4", bytes: 2000 });
  });

  test("no store → 转发 SSE，no crash", async () => {
    const app = makeApp(baseDeps({ store: null }), "user-1");
    const r = await app.fetch(new Request("http://x/api/voice", { method: "POST", headers: { "content-type": "audio/mp4" }, body: audioBytes() }));
    expect(r.status).toBe(200);
    await drain(r);
  });

  test("no identity → does NOT persist (but still 转发)", async () => {
    const store = fakeStore();
    const app = makeApp(baseDeps({ store }), undefined);
    const r = await app.fetch(new Request("http://x/api/voice", { method: "POST", headers: { "content-type": "audio/mp4" }, body: audioBytes() }));
    expect(r.status).toBe(200);
    await drain(r);
    expect(store.rows.length).toBe(0);
  });

  test("empty done.text → not persisted", async () => {
    const store = fakeStore();
    const app = makeApp(baseDeps({ store, intake: async () => sse(doneEvent("   ")) }), "user-1");
    const r = await app.fetch(new Request("http://x/api/voice", { method: "POST", headers: { "content-type": "audio/mp4" }, body: audioBytes() }));
    await drain(r);
    expect(store.rows.length).toBe(0);
  });

  test("disabled → 501", async () => {
    const app = makeApp(baseDeps({ enabled: false }), "user-1");
    const r = await app.fetch(new Request("http://x/api/voice", { method: "POST", body: audioBytes() }));
    expect(r.status).toBe(501);
  });

  test("audio too short → 400", async () => {
    const app = makeApp(baseDeps(), "user-1");
    const r = await app.fetch(new Request("http://x/api/voice", { method: "POST", body: new Uint8Array(10) }));
    expect(r.status).toBe(400);
  });

  test("oversized declared content-length → 413 (before buffering)", async () => {
    const app = makeApp(baseDeps(), "user-1");
    const r = await app.fetch(new Request("http://x/api/voice", {
      method: "POST",
      headers: { "content-type": "audio/mp4", "content-length": String(30 * 1024 * 1024) },
      body: audioBytes(),
    }));
    expect(r.status).toBe(413);
  });

  test("intake 上游 502 → 502（不转发空流）", async () => {
    const app = makeApp(baseDeps({ intake: async () => new Response("no", { status: 502 }) }), "user-1");
    const r = await app.fetch(new Request("http://x/api/voice", { method: "POST", headers: { "content-type": "audio/mp4" }, body: audioBytes() }));
    expect(r.status).toBe(502);
  });

  test("persist failure does not break转发 (best-effort)", async () => {
    const store = { add() { throw new Error("db down"); }, listByUid: () => [], findOwnedBlob: () => null };
    const app = makeApp(baseDeps({ store }), "user-1");
    const r = await app.fetch(new Request("http://x/api/voice", { method: "POST", headers: { "content-type": "audio/mp4" }, body: audioBytes() }));
    expect(r.status).toBe(200);
    await drain(r); // onDone 内 store.add 抛错被吞，转发不受影响
  });
});

describe("buildVoiceRoutes · GET /api/voice/history", () => {
  test("returns this user's items, newest first", async () => {
    const store = fakeStore();
    store.add({ uid: "user-1", text: "first", audioBlobId: "B1", mime: "audio/mp4", bytes: 1 });
    store.add({ uid: "user-1", text: "second", audioBlobId: "B2", mime: "audio/mp4", bytes: 1 });
    store.add({ uid: "other", text: "theirs", audioBlobId: "B3", mime: "audio/mp4", bytes: 1 });
    const app = makeApp(baseDeps({ store }), "user-1");
    const r = await app.fetch(new Request("http://x/api/voice/history"));
    expect(r.status).toBe(200);
    const { items } = (await r.json()) as { items: VoiceRecordRow[] };
    expect(items.map((i) => i.text)).toEqual(["second", "first"]);
  });

  test("no store → 501", async () => {
    const app = makeApp(baseDeps({ store: null }), "user-1");
    const r = await app.fetch(new Request("http://x/api/voice/history"));
    expect(r.status).toBe(501);
  });

  test("no identity → 401", async () => {
    const app = makeApp(baseDeps({ store: fakeStore() }), undefined);
    const r = await app.fetch(new Request("http://x/api/voice/history"));
    expect(r.status).toBe(401);
  });
});

describe("buildVoiceRoutes · GET /api/voice/audio/:id", () => {
  const withAudio = () => {
    const store = fakeStore();
    store.add({ uid: "user-1", text: "x", audioBlobId: "MINE", mime: "audio/mp4", bytes: 1 });
    store.add({ uid: "other", text: "y", audioBlobId: "THEIRS", mime: "audio/webm", bytes: 1 });
    return store;
  };

  test("owned blob → proxies bytes with stored mime, passes blobId verbatim", async () => {
    const store = withAudio();
    let seen = "";
    const fetchBlob = async (id: string) => { seen = id; return new Response(new Uint8Array([1, 2, 3]), { status: 200 }); };
    const app = makeApp(baseDeps({ store, fetchBlob }), "user-1");
    const r = await app.fetch(new Request("http://x/api/voice/audio/MINE"));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("audio/mp4");
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(seen).toBe("MINE");
  });

  test("blob owned by another user → 404 (no cross-user fetch)", async () => {
    const store = withAudio();
    const fetchBlob = async () => new Response(new Uint8Array([9]), { status: 200 });
    const app = makeApp(baseDeps({ store, fetchBlob }), "user-1");
    const r = await app.fetch(new Request("http://x/api/voice/audio/THEIRS"));
    expect(r.status).toBe(404);
  });

  test("unknown blob → 404", async () => {
    const app = makeApp(baseDeps({ store: withAudio(), fetchBlob: async () => new Response("x") }), "user-1");
    const r = await app.fetch(new Request("http://x/api/voice/audio/NOPE"));
    expect(r.status).toBe(404);
  });

  test("no fetchBlob configured → 501", async () => {
    const app = makeApp(baseDeps({ store: withAudio() }), "user-1");
    const r = await app.fetch(new Request("http://x/api/voice/audio/MINE"));
    expect(r.status).toBe(501);
  });

  test("upstream blob fetch fails → 502", async () => {
    const store = withAudio();
    const app = makeApp(baseDeps({ store, fetchBlob: async () => new Response("no", { status: 500 }) }), "user-1");
    const r = await app.fetch(new Request("http://x/api/voice/audio/MINE"));
    expect(r.status).toBe(502);
  });

  test("no identity → 401", async () => {
    const app = makeApp(baseDeps({ store: withAudio(), fetchBlob: async () => new Response("x") }), undefined);
    const r = await app.fetch(new Request("http://x/api/voice/audio/MINE"));
    expect(r.status).toBe(401);
  });
});
