import { Hono } from "hono";
import { createLogger } from "./logger";

const logger = createLogger("voice");

// 音频上限：手机录音几十秒也就几百 KB，25MB 足够且挡住超大 body OOM。
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

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
  transcribe: (bytes: Uint8Array) => Promise<{ text: string; audioBlobId: string }>;
  clean: (text: string) => Promise<string>;
  // 可选：按账号保存。null/缺省 → 不持久化（向后兼容）。
  store?: VoiceStoreLike | null;
  // 可选：音频回放代理（取 mp-blob 字节）。缺省 → /api/voice/audio 返回 501。
  fetchBlob?: (blobId: string) => Promise<Response>;
};

// 录音字节 → 转写 → 轻整理 → 返回文本（前端落框待复核，不发送）。
// 可观测性：分阶段计时，写日志（svc logs 可见）+ Server-Timing 头 + JSON 里带 t（前端展示）。
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
    const t0 = Date.now();
    let text: string;
    let audioBlobId: string;
    try { ({ text, audioBlobId } = await deps.transcribe(bytes)); }
    catch (e) { logger.warn({ err: (e as Error).message }, "transcribe failed"); return c.json({ error: "transcribe failed" }, 502); }
    const tAsr = Date.now();
    const cleaned = await deps.clean(text); // clean 内部已降级，不抛
    const tEnd = Date.now();
    const t = { transcribeMs: tAsr - t0, cleanMs: tEnd - tAsr, totalMs: tEnd - t0 };

    // 按账号保存（best-effort，失败不影响返回）。无 identity 或空文本不存。
    // 注意：经 gate 的请求 identity=真实 uid（隔离）；本地 hub.secret 直连统一为 "local-secret"
    // 共享桶——这是单主自用部署的设定（hub.secret 即个人凭据）；若 secret 给了第二人则其记录会混。
    const uid = c.var.identity;
    if (deps.store && uid && cleaned.trim()) {
      try { deps.store.add({ uid, text: cleaned, audioBlobId, mime, bytes: bytes.byteLength }); }
      catch (e) { logger.warn({ err: (e as Error).message }, "voice persist failed"); }
    }

    logger.info({ bytes: bytes.byteLength, uid, ...t }, "voice done");
    c.header("Server-Timing", `transcribe;dur=${t.transcribeMs}, clean;dur=${t.cleanMs}, total;dur=${t.totalMs}`);
    return c.json({ text: cleaned, t });
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
