import { describe, test, expect } from "bun:test";
import { callWorker, callOpus, type FetchLike, type WorkerConfig, type OpusConfig } from "../lib/clients";

// ——— Worker (gpt/gpt-5.4-mini, /v1/responses, SSE) ———

function makeSseResponse(text: string): Response {
  const body = [
    `data: {"type":"response.output_text.delta","delta":"${text}"}`,
    `data: {"type":"response.output_text.done","text":"${text}"}`,
    `data: [DONE]`,
  ].join("\n");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const WORKER_CFG: WorkerConfig = {
  endpoint: "http://127.0.0.1:15721/v1/responses",
  model: "gpt/gpt-5.4-mini",
  timeoutMs: 5000,
};

describe("callWorker", () => {
  test("happy-path: 解析 SSE output_text.done", async () => {
    let captured: unknown = null;
    const fetchImpl: FetchLike = async (_url, init) => {
      captured = JSON.parse(String((init as RequestInit).body));
      return makeSseResponse("set_claude_ccswitch_qwen");
    };
    const result = await callWorker({ ...WORKER_CFG, fetchImpl }, [
      { role: "system", content: "sys" },
      { role: "user", content: "切换到千问" },
    ]);
    expect(result).toBe("set_claude_ccswitch_qwen");
    // 验证请求格式：input 数组（responses 格式，非 messages）
    expect((captured as { input: unknown[] }).input).toBeDefined();
    expect((captured as { model: string }).model).toBe("gpt/gpt-5.4-mini");
  });

  test("非 2xx → 抛错", async () => {
    const fetchImpl: FetchLike = async () => new Response("err", { status: 500 });
    await expect(callWorker({ ...WORKER_CFG, fetchImpl }, [{ role: "user", content: "hi" }]))
      .rejects.toThrow();
  });

  test("空 SSE 输出 → 抛错", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(`data: {"type":"response.completed"}`, { status: 200 });
    await expect(callWorker({ ...WORKER_CFG, fetchImpl }, [{ role: "user", content: "hi" }]))
      .rejects.toThrow();
  });
});

// ——— Opus (claude-opus-4-8, /v1/messages, Anthropic format) ———

function makeOpusResponse(text: string): Response {
  return new Response(
    JSON.stringify({ content: [{ type: "text", text }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const OPUS_CFG: OpusConfig = {
  endpoint: "http://127.0.0.1:15721/v1/messages",
  model: "lingzhi/claude-opus-4-8",
  maxTokens: 512,
  timeoutMs: 5000,
};

describe("callOpus", () => {
  test("happy-path: 解析 /v1/messages 响应", async () => {
    let captured: unknown = null;
    const fetchImpl: FetchLike = async (_url, init) => {
      captured = JSON.parse(String((init as RequestInit).body));
      return makeOpusResponse('{"verdict_a":"correct","rationale_a":"ok","verdict_b":"correct","rationale_b":"ok"}');
    };
    const result = await callOpus(
      { ...OPUS_CFG, fetchImpl },
      "你是评分专家",
      [{ role: "user", content: "nl: 切换千问\nexpected_cmd: set_claude_ccswitch_qwen\nproduced_a: set_claude_ccswitch_qwen\nproduced_b: set_claude_ccswitch_qwen" }],
    );
    expect(result).toContain("correct");
    // 验证 Anthropic 格式
    expect((captured as { system: string }).system).toBe("你是评分专家");
    expect((captured as { messages: unknown[] }).messages).toBeDefined();
    expect((captured as { model: string }).model).toBe("lingzhi/claude-opus-4-8");
  });

  test("非 2xx → 抛错", async () => {
    const fetchImpl: FetchLike = async () => new Response("err", { status: 429 });
    await expect(callOpus({ ...OPUS_CFG, fetchImpl }, "sys", [{ role: "user", content: "hi" }]))
      .rejects.toThrow();
  });

  test("空 content → 抛错", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ content: [] }), { status: 200 });
    await expect(callOpus({ ...OPUS_CFG, fetchImpl }, "sys", [{ role: "user", content: "hi" }]))
      .rejects.toThrow();
  });
});
