import { describe, test, expect, mock } from "bun:test";
import { transcribeAudio, blobIdToHex } from "../../src/server/voice/transcribe";

describe("blobIdToHex", () => {
  const HEX = "3f6e2f8198396a6885b90fe15e440d97e24b094331c9548be0bfe3ec313e84cd";
  test("strips blob:// scheme → bare hex (encodeURIComponent-safe)", () => {
    expect(blobIdToHex(`blob://${HEX}`)).toBe(HEX);
    expect(encodeURIComponent(blobIdToHex(`blob://${HEX}`))).toBe(HEX); // no %-escapes
  });
  test("bare hex passes through unchanged", () => {
    expect(blobIdToHex(HEX)).toBe(HEX);
  });
});

describe("transcribeAudio", () => {
  test("happy: blob→asr 链路返回 text", async () => {
    const fetchFn = mock(async (url: string) => {
      if (url.endsWith("/blob")) return new Response(JSON.stringify({ blob_id: "B1" }), { status: 200 });
      if (url.endsWith("/asr")) return new Response(JSON.stringify({ text: "你好世界" }), { status: 200 });
      return new Response("x", { status: 404 });
    });
    const out = await transcribeAudio(new Uint8Array([1, 2, 3]), { blobBase: "http://b", asrBase: "http://a", fetchFn });
    expect(out.text).toBe("你好世界");
    expect(out.audioBlobId).toBe("B1"); // 复用上传的 blob_id
  });
  test("blob 非 2xx 抛错", async () => {
    const fetchFn = mock(async () => new Response("nope", { status: 500 }));
    await expect(transcribeAudio(new Uint8Array([1]), { blobBase: "http://b", asrBase: "http://a", fetchFn }))
      .rejects.toThrow(/blob/);
  });
  test("asr 非 2xx 抛错", async () => {
    const fetchFn = mock(async (url: string) =>
      url.endsWith("/blob") ? new Response(JSON.stringify({ blob_id: "B1" }), { status: 200 }) : new Response("e", { status: 502 }));
    await expect(transcribeAudio(new Uint8Array([1]), { blobBase: "http://b", asrBase: "http://a", fetchFn }))
      .rejects.toThrow(/asr/);
  });
});
