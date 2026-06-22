import { Hono } from "hono";
import { createLogger } from "./logger";

const logger = createLogger("voice");

export type VoiceRouteDeps = {
  enabled: boolean;
  transcribe: (bytes: Uint8Array) => Promise<{ text: string }>;
  clean: (text: string) => Promise<string>;
};

// 录音字节 → 转写 → 轻整理 → 返回文本（前端落框待复核，不发送）。
// 可观测性：分阶段计时，写日志（svc logs 可见）+ Server-Timing 头 + JSON 里带 t（前端展示）。
export function buildVoiceRoutes(deps: VoiceRouteDeps): Hono {
  const r = new Hono();
  r.post("/api/voice", async (c) => {
    if (!deps.enabled) return c.json({ error: "voice disabled" }, 501);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength < 1000) return c.json({ error: "audio too short" }, 400);
    const t0 = Date.now();
    let text: string;
    try { ({ text } = await deps.transcribe(bytes)); }
    catch (e) { logger.warn({ err: (e as Error).message }, "transcribe failed"); return c.json({ error: "transcribe failed" }, 502); }
    const tAsr = Date.now();
    const cleaned = await deps.clean(text); // clean 内部已降级，不抛
    const tEnd = Date.now();
    const t = { transcribeMs: tAsr - t0, cleanMs: tEnd - tAsr, totalMs: tEnd - t0 };
    logger.info({ bytes: bytes.byteLength, ...t }, "voice done");
    c.header("Server-Timing", `transcribe;dur=${t.transcribeMs}, clean;dur=${t.cleanMs}, total;dur=${t.totalMs}`);
    return c.json({ text: cleaned, t });
  });
  return r;
}
