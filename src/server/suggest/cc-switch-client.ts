import type { ChatMessage } from "./prompt";

export type ModelCaller = (messages: ChatMessage[]) => Promise<string>;

// Minimal fetch signature needed for making HTTP requests; narrower than `typeof fetch`
// so test stubs (plain async functions) can be passed without needing `preconnect`.
export type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type CcSwitchConfig = {
  endpoint: string;
  model: string;
  timeoutMs: number;
  fetchImpl?: FetchLike;
};

export function makeCcSwitchCaller(cfg: CcSwitchConfig): ModelCaller {
  const doFetch: FetchLike = cfg.fetchImpl ?? fetch;
  return async (messages) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    try {
      const res = await doFetch(cfg.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
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
