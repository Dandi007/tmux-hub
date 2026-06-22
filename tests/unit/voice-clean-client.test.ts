import { describe, test, expect, mock } from "bun:test";
import { cleanViaCcSwitch } from "../../src/server/voice/clean-client";

const D = (fetchFn: any) => ({ endpoint: "http://cc", model: "lingzhi/kimi-k2.6", timeoutMs: 1000, fetchFn });
const chat = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

describe("cleanViaCcSwitch", () => {
  test("happy: 返回 choices[0].message.content（trim）", async () => {
    const fetchFn = mock(async () => chat("  整理后  "));
    expect(await cleanViaCcSwitch("原始", D(fetchFn))).toBe("整理后");
  });
  test("发往 /v1/chat/completions 且带 model", async () => {
    let seenUrl = "", seenBody: any = null;
    const fetchFn = mock(async (url: string, init: any) => { seenUrl = url; seenBody = JSON.parse(init.body); return chat("ok"); });
    await cleanViaCcSwitch("原始", D(fetchFn));
    expect(seenUrl).toBe("http://cc/v1/chat/completions");
    expect(seenBody.model).toBe("lingzhi/kimi-k2.6");
    expect(seenBody.messages[1].content).toBe("原始");
  });
  test("非 2xx → 降级返回原文", async () => {
    const fetchFn = mock(async () => new Response("err", { status: 502 }));
    expect(await cleanViaCcSwitch("原始", D(fetchFn))).toBe("原始");
  });
  test("抛错（服务不可达/超时）→ 降级返回原文", async () => {
    const fetchFn = mock(async () => { throw new Error("ECONNREFUSED"); });
    expect(await cleanViaCcSwitch("原始", D(fetchFn))).toBe("原始");
  });
  test("空 content → 降级返回原文", async () => {
    const fetchFn = mock(async () => chat("  "));
    expect(await cleanViaCcSwitch("原始", D(fetchFn))).toBe("原始");
  });
  test("缺 choices → 降级返回原文", async () => {
    const fetchFn = mock(async () => new Response(JSON.stringify({}), { status: 200 }));
    expect(await cleanViaCcSwitch("原始", D(fetchFn))).toBe("原始");
  });
});
