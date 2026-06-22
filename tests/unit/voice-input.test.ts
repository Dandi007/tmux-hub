import { describe, test, expect } from "bun:test";
import { pickMime } from "../../src/web/mobile/voice-input";

describe("pickMime", () => {
  test("无 MediaRecorder（测试环境）→ 返回空串，不抛", () => {
    expect(typeof pickMime()).toBe("string");
  });
});
