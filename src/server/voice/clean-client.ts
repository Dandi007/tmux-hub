// 语音 ASR 整理：调 cc-switch（OpenAI 兼容 /v1/chat/completions）做轻整理。
// 任何失败/超时/空返回都降级为原始 text（语音绝不丢字）。
// 此前走 sub-clean（订阅 Agent SDK 暖会话，5~13s 有冷启动尖峰）；改走 cc-switch 无状态
// HTTP（实测 kimi-k2.6 ~0.8s、haiku ~2s），质量同档、延迟降一个数量级。
const SYSTEM =
  "你是语音转写整理器。把下面这段语音 ASR 文本整理成通顺的纯文本：去掉口头禅与填充词（嗯/呃/那个/就是/这个/重复语/重新开头的口误），纠正同音/明显 typo，补标点。严禁改变原意、增删信息、翻译、解释或把它转成命令。只输出整理后的纯文本，不要任何前后缀。";

export interface CleanDeps { endpoint: string; model: string; timeoutMs: number; fetchFn?: typeof fetch; }

export async function cleanViaCcSwitch(text: string, deps: CleanDeps): Promise<string> {
  const doFetch = deps.fetchFn ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs);
  try {
    const res = await doFetch(`${deps.endpoint}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deps.model,
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: text }],
        max_tokens: 1000,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return text;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const out = (data.choices?.[0]?.message?.content ?? "").trim();
    return out || text;
  } catch {
    return text;
  } finally {
    clearTimeout(timer);
  }
}
