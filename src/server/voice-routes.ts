import { Hono } from "hono";
import { createLogger } from "./logger";
import { pipeIntakeSse, type IntakeDone } from "./voice/intake-client";

const logger = createLogger("voice");

// 音频上限：手机录音几十秒也就几百 KB，25MB 足够且挡住超大 body OOM。
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

// hub 用哪张 voice-intake prompt-card。落库时一并记下，换 card 后历史仍可归因。
export const VOICE_CARD = "hub-polish";

export interface VoiceRecordRow {
  id: number;
  text: string;
  audio_blob_id: string | null;
  mime: string | null;
  bytes: number | null;
  created_at: string;
}

// 持久化接口（VoiceStore 实现）。注入式，便于测试与可选启用。
export interface VoiceStoreLike {
  add(rec: { uid: string; text: string; audioBlobId: string | null; mime: string | null; bytes: number | null }): void;
  listByUid(uid: string, limit?: number): VoiceRecordRow[];
  findOwnedBlob(uid: string, blobId: string): { mime: string | null } | null;
}

export type VoiceRouteDeps = {
  enabled: boolean;
  // 调 voice-intake 的 SSE，返回上游 Response（hub 把事件流原样转发给浏览器）。
  intake: (bytes: Uint8Array) => Promise<Response>;
  // 可选：按账号保存。null/缺省 → 不持久化（向后兼容）。
  store?: VoiceStoreLike | null;
  // 可选：音频回放代理（取 mp-blob 字节）。缺省 → /api/voice/audio 返回 501。
  fetchBlob?: (blobId: string) => Promise<Response>;
};

// 录音字节 → 转发 voice-intake 的 SSE（uploaded/transcribing/transcribed/cleaning/done）。
// hub 不再自己串 blob→asr→clean：编排+整理+降级全在 voice-intake。
// 旁路：在 done 事件按账号落库（best-effort，不阻断转发）。
// 账号绑定：identity 由 authGate 设置（经 gate 为真实 uid，本地直连为 "local-secret"）。
export function buildVoiceRoutes(deps: VoiceRouteDeps): Hono {
  const r = new Hono();

  r.post("/api/voice", async (c) => {
    if (!deps.enabled) return c.json({ error: "voice disabled" }, 501);
    const mime = c.req.header("content-type") ?? null;
    // Content-Length 早挡超大 body（可被 chunked 绕过，故下面再按实际字节数兜底）。
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > MAX_AUDIO_BYTES) return c.json({ error: "audio too large" }, 413);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength > MAX_AUDIO_BYTES) return c.json({ error: "audio too large" }, 413);
    if (bytes.byteLength < 1000) return c.json({ error: "audio too short" }, 400);

    const uid = c.var.identity;
    let upstream: Response;
    try { upstream = await deps.intake(bytes); }
    catch (e) { logger.warn({ err: (e as Error).message }, "intake failed"); return c.json({ error: "transcribe failed" }, 502); }
    if (!upstream.ok || !upstream.body) return c.json({ error: "transcribe failed" }, 502);

    // done 时按账号保存（best-effort）；注意：经 gate 的请求 identity=真实 uid（隔离），
    // 本地 hub.secret 直连统一为 "local-secret" 共享桶（单主自用设定）。
    const onDone = (d: IntakeDone) => {
      if (deps.store && uid && d.text?.trim()) {
        try {
          // 同时存 ASR 原文与润色结果：这是 prompt 调优唯一的真实语料来源——
          // 只存润色后文本的话，模型跑偏了也无从复盘、换 prompt 无从回归验证。
          deps.store.add({
            uid, text: d.text, rawText: d.raw_text ?? null,
            card: VOICE_CARD, degraded: d.degraded ?? null,
            audioBlobId: d.audio_blob_id, mime, bytes: bytes.byteLength,
          });
        }
        catch (e) { logger.warn({ err: (e as Error).message }, "voice persist failed"); }
      }
      logger.info({ bytes: bytes.byteLength, uid, cleaned: d.cleaned, degraded: d.degraded, ...d.t }, "voice done");
    };

    const piped = pipeIntakeSse(upstream.body, onDone);
    return new Response(piped, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
  });

  // 我的语音历史（当前账号，新到旧）。非读路径 → authGate 已要求鉴权，identity 必有。
  r.get("/api/voice/history", (c) => {
    if (!deps.enabled || !deps.store) return c.json({ error: "voice history unavailable" }, 501);
    const uid = c.var.identity;
    if (!uid) return c.json({ error: "unauthorized" }, 401);
    return c.json({ items: deps.store.listByUid(uid, 50) });
  });

  // 音频回放：仅能取自己记录里的 blob（防越权取任意 blob_id）。
  r.get("/api/voice/audio/:id", async (c) => {
    if (!deps.enabled || !deps.store || !deps.fetchBlob) return c.json({ error: "audio unavailable" }, 501);
    const uid = c.var.identity;
    if (!uid) return c.json({ error: "unauthorized" }, 401);
    const blobId = c.req.param("id");
    const owned = deps.store.findOwnedBlob(uid, blobId);
    if (!owned) return c.json({ error: "not found" }, 404);
    let res: Response;
    try { res = await deps.fetchBlob(blobId); }
    catch (e) { logger.warn({ err: (e as Error).message }, "audio fetch failed"); return c.json({ error: "audio fetch failed" }, 502); }
    if (!res.ok || !res.body) return c.json({ error: "audio fetch failed" }, 502);
    // mp-blob 不带可靠 content-type；用记录里存的 mime 回放。
    const headers = new Headers();
    headers.set("Content-Type", owned.mime || "application/octet-stream");
    headers.set("Cache-Control", "private, max-age=3600");
    return new Response(res.body, { status: 200, headers });
  });

  return r;
}
