import { describe, test, expect } from "bun:test";
import { blobIdToHex } from "../../src/server/voice/transcribe";

// 转写编排（blob→asr）已下沉到 voice-intake 服务，hub 侧只剩回放用的 blobIdToHex。
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
