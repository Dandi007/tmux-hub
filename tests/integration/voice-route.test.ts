import { describe, test, expect } from "bun:test";
import { buildVoiceRoutes } from "../../src/server/voice-routes";

// /api/voice 现转发 voice-intake 的 SSE：intake 返回上游 SSE Response，hub 原样转发。
function sse(events: string): Response {
  return new Response(new TextEncoder().encode(events), { status: 200, headers: { "content-type": "text/event-stream" } });
}
const doneEvent = (text: string) =>
  `event: uploaded\ndata: ${JSON.stringify({ audio_blob_id: "blob://B1" })}\n\n` +
  `event: done\ndata: ${JSON.stringify({ text, raw_text: "原始转写", audio_blob_id: "blob://B1", t: { transcribeMs: 1, cleanMs: 1, totalMs: 2 } })}\n\n`;

function app(over: Partial<Parameters<typeof buildVoiceRoutes>[0]> = {}) {
  return buildVoiceRoutes({
    enabled: true,
    intake: async () => sse(doneEvent("整理后的文本")),
    ...over,
  });
}
const post = (a: ReturnType<typeof buildVoiceRoutes>, body: Uint8Array) =>
  a.request("/api/voice", { method: "POST", body: body as BodyInit, headers: { "content-type": "audio/mp4" } });

describe("POST /api/voice", () => {
  test("flag 关 → 501", async () => {
    const res = await post(app({ enabled: false }), new Uint8Array(2000));
    expect(res.status).toBe(501);
  });
  test("音频过短 → 400", async () => {
    const res = await post(app(), new Uint8Array(10));
    expect(res.status).toBe(400);
  });
  test("happy → 转发 SSE，流里含 done + 整理后文本", async () => {
    const res = await post(app(), new Uint8Array(2000));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const txt = await res.text();
    expect(txt).toContain("event: done");
    expect(txt).toContain("整理后的文本");
  });
  test("intake 抛错 → 502", async () => {
    const res = await post(app({ intake: async () => { throw new Error("intake down"); } }), new Uint8Array(2000));
    expect(res.status).toBe(502);
  });
  test("intake 上游非 2xx → 502", async () => {
    const res = await post(app({ intake: async () => new Response("no", { status: 502 }) }), new Uint8Array(2000));
    expect(res.status).toBe(502);
  });
});
