import { Hono } from "hono";

export type VoiceRouteDeps = {
  enabled: boolean;
  transcribe: (bytes: Uint8Array) => Promise<{ text: string }>;
  clean: (text: string) => Promise<string>;
};

// 录音字节 → 转写 → 轻整理 → 返回文本（前端落框待复核，不发送）。
export function buildVoiceRoutes(deps: VoiceRouteDeps): Hono {
  const r = new Hono();
  r.post("/api/voice", async (c) => {
    if (!deps.enabled) return c.json({ error: "voice disabled" }, 501);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength < 1000) return c.json({ error: "audio too short" }, 400);
    let text: string;
    try { ({ text } = await deps.transcribe(bytes)); }
    catch { return c.json({ error: "transcribe failed" }, 502); }
    const cleaned = await deps.clean(text); // clean 内部已降级，不抛
    return c.json({ text: cleaned });
  });
  return r;
}
