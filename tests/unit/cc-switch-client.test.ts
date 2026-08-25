import { describe, test, expect } from "bun:test";
import { makeCcSwitchCaller, parseResponsesSse, type FetchLike } from "../../src/server/suggest/cc-switch-client";

function okResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

// Minimal Codex /v1/responses SSE body (the shape ccs's gpt/* reverse-proxy returns).
function sseResponse(text: string): Response {
  const body = [
    `event: response.created`,
    `data: {"type":"response.created","response":{"id":"r1"}}`,
    ``,
    `event: response.output_text.delta`,
    `data: {"type":"response.output_text.delta","delta":"${text}"}`,
    ``,
    `event: response.output_text.done`,
    `data: {"type":"response.output_text.done","content_index":0,"text":"${text}"}`,
    ``,
    `event: response.completed`,
    `data: {"type":"response.completed","response":{"id":"r1"}}`,
    ``,
  ].join("\n");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("makeCcSwitchCaller", () => {
  test("发 model+messages，取回 content", async () => {
    let seen: any = null;
    const fetchImpl: FetchLike = async (_url, init) => { seen = JSON.parse(String((init as RequestInit).body)); return okResponse("git push"); };
    const call = makeCcSwitchCaller({
      endpoint: "http://x/v1/chat/completions", model: "m", timeoutMs: 1000,
      fetchImpl,
    });
    const out = await call([{ role: "user", content: "hi" }]);
    expect(out).toBe("git push");
    expect(seen.model).toBe("m");
    expect(seen.messages[0].content).toBe("hi");
  });
  test("配 token → 带 Bearer 头；不配 → 无 authorization 头", async () => {
    let seenHeaders: Record<string, string> = {};
    const fetchImpl: FetchLike = async (_url, init) => {
      seenHeaders = (init as RequestInit).headers as Record<string, string>;
      return okResponse("ok");
    };
    const withToken = makeCcSwitchCaller({
      endpoint: "http://x/v1/chat/completions", model: "m", timeoutMs: 1000,
      token: "sk-test", fetchImpl,
    });
    await withToken([{ role: "user", content: "hi" }]);
    expect(seenHeaders.authorization).toBe("Bearer sk-test");

    const noToken = makeCcSwitchCaller({
      endpoint: "http://x/v1/chat/completions", model: "m", timeoutMs: 1000,
      fetchImpl,
    });
    await noToken([{ role: "user", content: "hi" }]);
    expect(seenHeaders.authorization).toBeUndefined();
  });

  test("非 2xx → 抛错", async () => {
    const fetchImpl: FetchLike = async () => new Response("nope", { status: 500 });
    const call = makeCcSwitchCaller({
      endpoint: "http://x", model: "m", timeoutMs: 1000,
      fetchImpl,
    });
    await expect(call([{ role: "user", content: "hi" }])).rejects.toThrow();
  });
  test("空 content → 抛错", async () => {
    const fetchImpl: FetchLike = async () => okResponse("   ");
    const call = makeCcSwitchCaller({
      endpoint: "http://x", model: "m", timeoutMs: 1000,
      fetchImpl,
    });
    await expect(call([{ role: "user", content: "hi" }])).rejects.toThrow();
  });
});

describe("parseResponsesSse", () => {
  test("从 output_text.done 取文本", () => {
    const body = [
      `data: {"type":"response.output_text.delta","delta":"git "}`,
      `data: {"type":"response.output_text.done","text":"git push"}`,
    ].join("\n");
    expect(parseResponsesSse(body)).toBe("git push");
  });
  test("多 content part 顺序拼接", () => {
    const body = [
      `data: {"type":"response.output_text.done","content_index":0,"text":"a"}`,
      `data: {"type":"response.output_text.done","content_index":1,"text":"b"}`,
    ].join("\n");
    expect(parseResponsesSse(body)).toBe("ab");
  });
  test("无 output_text → 空串", () => {
    expect(parseResponsesSse(`data: {"type":"response.created"}`)).toBe("");
  });
  test("跳过非 data 行与 [DONE]", () => {
    const body = `event: x\ndata: [DONE]\ndata: {"type":"response.output_text.done","text":"ok"}`;
    expect(parseResponsesSse(body)).toBe("ok");
  });
});

describe("makeCcSwitchCaller — responses protocol", () => {
  test("发 input 格式，从 SSE 取回文本", async () => {
    let seen: any = null;
    const fetchImpl: FetchLike = async (_url, init) => {
      seen = JSON.parse(String((init as RequestInit).body));
      return sseResponse("git push origin HEAD");
    };
    const call = makeCcSwitchCaller({
      endpoint: "http://x/v1/responses", model: "gpt/gpt-5.4-mini", timeoutMs: 1000,
      protocol: "responses", fetchImpl,
    });
    const out = await call([{ role: "system", content: "sys" }, { role: "user", content: "推上去" }]);
    expect(out).toBe("git push origin HEAD");
    expect(seen.model).toBe("gpt/gpt-5.4-mini");
    expect(seen.input[0].role).toBe("system");
    expect(seen.input[0].content[0]).toEqual({ type: "input_text", text: "sys" });
    expect(seen.input[1].content[0].text).toBe("推上去");
    expect("messages" in seen).toBe(false);
  });
  test("responses 非 2xx → 抛错", async () => {
    const fetchImpl: FetchLike = async () => new Response("x", { status: 404 });
    const call = makeCcSwitchCaller({
      endpoint: "http://x", model: "gpt/m", timeoutMs: 1000, protocol: "responses", fetchImpl,
    });
    await expect(call([{ role: "user", content: "hi" }])).rejects.toThrow();
  });
  test("responses 空输出 → 抛错", async () => {
    const fetchImpl: FetchLike = async () => new Response(`data: {"type":"response.completed"}`, { status: 200 });
    const call = makeCcSwitchCaller({
      endpoint: "http://x", model: "gpt/m", timeoutMs: 1000, protocol: "responses", fetchImpl,
    });
    await expect(call([{ role: "user", content: "hi" }])).rejects.toThrow();
  });
});
