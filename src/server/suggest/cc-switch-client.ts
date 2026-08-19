import type { ChatMessage } from "./prompt";

export type ModelCaller = (messages: ChatMessage[]) => Promise<string>;

// Minimal fetch signature needed for making HTTP requests; narrower than `typeof fetch`
// so test stubs (plain async functions) can be passed without needing `preconnect`.
export type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

// "chat" → OpenAI /v1/chat/completions (lingzhi/* and most providers).
// "responses" → Codex /v1/responses SSE (gpt/* GPT-OAuth reverse-proxy, which 404s on
// chat/completions — see cc-switch-proxy memory). Same model, different wire protocol.
export type SuggestProtocol = "chat" | "responses";

export type CcSwitchConfig = {
  endpoint: string;
  model: string;
  timeoutMs: number;
  protocol?: SuggestProtocol;
  // Bearer token（New API 网关 15722 必需；cc-switch 15721 无认证，留空即可）。
  token?: string;
  fetchImpl?: FetchLike;
};

// Parse a Codex /v1/responses SSE body (returned whole even with stream:false).
// The final assistant text lives in `response.output_text.done` events' `.text`
// (one per content part). Concatenate in arrival order; ignore reasoning/other events.
export function parseResponsesSse(body: string): string {
  let out = "";
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice("data:".length).trim();
    if (payload === "" || payload === "[DONE]") continue;
    let ev: { type?: string; text?: string };
    try { ev = JSON.parse(payload) as { type?: string; text?: string }; }
    catch { continue; }
    if (ev.type === "response.output_text.done" && typeof ev.text === "string") {
      out += ev.text;
    }
  }
  return out;
}

export function makeCcSwitchCaller(cfg: CcSwitchConfig): ModelCaller {
  const doFetch: FetchLike = cfg.fetchImpl ?? fetch;
  const protocol: SuggestProtocol = cfg.protocol ?? "chat";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  return async (messages) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    try {
      if (protocol === "responses") {
        const res = await doFetch(cfg.endpoint, {
          method: "POST",
          headers,
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
        if (!res.ok) throw new Error(`cc-switch ${res.status}`);
        const text = parseResponsesSse(await res.text());
        if (text.trim() === "") throw new Error("empty completion");
        return text;
      }

      const res = await doFetch(cfg.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: cfg.model, messages, temperature: 0, stream: false }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`cc-switch ${res.status}`);
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim() === "") throw new Error("empty completion");
      return content;
    } finally {
      clearTimeout(timer);
    }
  };
}
