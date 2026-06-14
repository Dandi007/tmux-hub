/**
 * eval/lib/clients.ts
 *
 * 两个模型调用器：
 *  - makeWorkerCaller：调 gpt/gpt-5.4-mini via /v1/responses（复用 parseResponsesSse）
 *  - makeOpusCaller：调 claude-opus-4-8 via /v1/messages（Anthropic 格式），gold-gen + judge 共用
 *
 * 两者均接受注入 fetch（fetchImpl），便于 fixture 离线测试。
 */

import { parseResponsesSse, type FetchLike } from "../../src/server/suggest/cc-switch-client";

export { type FetchLike };

// ——— Worker（gpt/gpt-5.4-mini, /responses, SSE）———

export type WorkerConfig = {
  endpoint: string; // e.g. "http://127.0.0.1:15721/v1/responses"
  model: string;    // e.g. "gpt/gpt-5.4-mini"
  timeoutMs: number;
  fetchImpl?: FetchLike;
};

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export async function callWorker(cfg: WorkerConfig, messages: ChatMessage[]): Promise<string> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const res = await doFetch(cfg.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        input: messages.map((m) => ({
          role: m.role,
          content: [{ type: "input_text", text: m.content }],
        })),
        stream: false,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`worker ${res.status}: ${await res.text()}`);
    const text = parseResponsesSse(await res.text());
    if (text.trim() === "") throw new Error("worker: empty completion");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// ——— Opus（claude-opus-4-8, /v1/messages, Anthropic format）———

export type OpusConfig = {
  endpoint: string;   // e.g. "http://127.0.0.1:15721/v1/messages"
  model: string;      // e.g. "lingzhi/claude-opus-4-8"
  maxTokens: number;
  timeoutMs: number;
  fetchImpl?: FetchLike;
};

export type OpusMessage = { role: "user" | "assistant"; content: string };

export async function callOpus(
  cfg: OpusConfig,
  systemPrompt: string,
  messages: OpusMessage[],
): Promise<string> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const res = await doFetch(cfg.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        system: systemPrompt,
        messages,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`opus ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const textBlock = body.content?.find((b) => b.type === "text");
    if (!textBlock || typeof textBlock.text !== "string" || textBlock.text.trim() === "") {
      throw new Error("opus: empty response");
    }
    return textBlock.text;
  } finally {
    clearTimeout(timer);
  }
}
