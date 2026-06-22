import { describe, test, expect } from "bun:test";
import { buildVoiceRoutes } from "../../src/server/voice-routes";

function app(over: Partial<Parameters<typeof buildVoiceRoutes>[0]> = {}) {
  return buildVoiceRoutes({
    enabled: true,
    transcribe: async () => ({ text: "原始转写" }),
    clean: async (t) => "整理:" + t,
    ...over,
  });
}
const post = (a: any, body: Uint8Array) =>
  a.request("/api/voice", { method: "POST", body, headers: { "content-type": "audio/mp4" } });

describe("POST /api/voice", () => {
  test("flag 关 → 501", async () => {
    const res = await post(app({ enabled: false }), new Uint8Array(2000));
    expect(res.status).toBe(501);
  });
  test("音频过短 → 400", async () => {
    const res = await post(app(), new Uint8Array(10));
    expect(res.status).toBe(400);
  });
  test("happy → transcribe→clean 后返回 text", async () => {
    const res = await post(app(), new Uint8Array(2000));
    expect(res.status).toBe(200);
    expect((await res.json()).text).toBe("整理:原始转写");
  });
  test("transcribe 抛错 → 502", async () => {
    const res = await post(app({ transcribe: async () => { throw new Error("asr down"); } }), new Uint8Array(2000));
    expect(res.status).toBe(502);
  });
  test("clean 降级（返回原文）不影响 200", async () => {
    const res = await post(app({ clean: async (t) => t }), new Uint8Array(2000));
    expect(res.status).toBe(200);
    expect((await res.json()).text).toBe("原始转写");
  });
});
