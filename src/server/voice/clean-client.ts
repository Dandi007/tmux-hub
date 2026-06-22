export interface CleanDeps { endpoint: string; timeoutMs: number; fetchFn?: typeof fetch; }

// 调 sub-clean 服务做轻整理；任何失败/超时/空返回都降级为原始 text（语音绝不丢字）。
export async function cleanViaService(text: string, deps: CleanDeps): Promise<string> {
  const doFetch = deps.fetchFn ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs);
  try {
    const res = await doFetch(`${deps.endpoint}/clean`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }), signal: ctrl.signal,
    });
    if (!res.ok) return text;
    const data = (await res.json()) as { text?: string };
    const out = (data.text ?? "").trim();
    return out || text;
  } catch {
    return text;
  } finally {
    clearTimeout(timer);
  }
}
