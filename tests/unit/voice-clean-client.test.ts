import { describe, test, expect, mock } from "bun:test";
import { cleanViaService } from "../../src/server/voice/clean-client";

const D = (fetchFn: any) => ({ endpoint: "http://c", timeoutMs: 1000, fetchFn });

describe("cleanViaService", () => {
  test("happy: 返回整理后文本", async () => {
    const fetchFn = mock(async () => new Response(JSON.stringify({ text: "整理后" }), { status: 200 }));
    expect(await cleanViaService("原始", D(fetchFn))).toBe("整理后");
  });
  test("非 2xx → 降级返回原文", async () => {
    const fetchFn = mock(async () => new Response("err", { status: 502 }));
    expect(await cleanViaService("原始", D(fetchFn))).toBe("原始");
  });
  test("抛错（服务不可达）→ 降级返回原文", async () => {
    const fetchFn = mock(async () => { throw new Error("ECONNREFUSED"); });
    expect(await cleanViaService("原始", D(fetchFn))).toBe("原始");
  });
  test("空返回 → 降级返回原文", async () => {
    const fetchFn = mock(async () => new Response(JSON.stringify({ text: "  " }), { status: 200 }));
    expect(await cleanViaService("原始", D(fetchFn))).toBe("原始");
  });
});
