// 文件上传的 TOS 直传路径：hub 只负责签发代理与验收转发，字节不经过 hub。
//
// 老路径（POST /sessions/:name/upload-image，multipart 进 hub 再落盘）保留不动，
// 前端优先走这条，失败自动降级——broker 没起、TOS 不通、公司网络挡了直传，
// 都不该让用户传不了图。
//
// hub 从不持有 TOS 凭证：签名由本机 loopback 上的 upload-broker 生成。
import { Hono } from "hono";
import { isGrammarOk } from "../shared/session-name";
import { createLogger } from "./logger";

const logger = createLogger("upload-broker");

export type UploadBrokerDeps = {
  enabled: boolean;
  base: string;
  namespace: string;
  token: string;
  sessionExists: (name: string) => boolean;
  fetchImpl?: typeof fetch;
};

type InitBody = { filename?: unknown; size?: unknown; mime?: unknown };

export function buildUploadBrokerRoutes(deps: UploadBrokerDeps): Hono {
  const r = new Hono();
  const doFetch = deps.fetchImpl ?? fetch;

  const brokerHeaders = {
    "content-type": "application/json",
    "x-upload-namespace": deps.namespace,
    authorization: `Bearer ${deps.token}`,
  };

  /** 会话校验对两个端点都适用：路径最终要注入这个 session 的 pane。 */
  function guard(name: string): Response | null {
    if (!deps.enabled) {
      return Response.json({ error: "upload broker disabled" }, { status: 501 });
    }
    if (!isGrammarOk(name)) return Response.json({ error: "session name grammar" }, { status: 400 });
    if (!deps.sessionExists(name)) return Response.json({ error: "session not found" }, { status: 410 });
    return null;
  }

  r.post("/sessions/:name/upload-init", async (c) => {
    const name = c.req.param("name");
    const bad = guard(name);
    if (bad) return bad;

    let body: InitBody;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    let res: Response;
    try {
      res = await doFetch(`${deps.base}/v1/uploads/init`, {
        method: "POST",
        headers: brokerHeaders,
        body: JSON.stringify({
          filename: typeof body.filename === "string" ? body.filename : "",
          size: body.size,
          mime: typeof body.mime === "string" ? body.mime : "",
        }),
      });
    } catch (e) {
      logger.warn({ session: name, err: (e as Error).message }, "broker unreachable");
      return c.json({ error: "upload broker unreachable" }, 502);
    }

    const text = await res.text();
    if (!res.ok) {
      logger.warn({ session: name, status: res.status, body: text.slice(0, 200) }, "broker init failed");
      // 原样透传状态码，前端据此决定重试还是降级。
      return new Response(text, {
        status: res.status,
        headers: { "content-type": "application/json" },
      });
    }
    logger.info({ session: name }, "upload init signed");
    return new Response(text, { headers: { "content-type": "application/json" } });
  });

  r.post("/sessions/:name/upload-commit", async (c) => {
    const name = c.req.param("name");
    const bad = guard(name);
    if (bad) return bad;

    let body: { uploadId?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const uploadId = typeof body.uploadId === "string" ? body.uploadId : "";
    // 只放行 UUID 形状，避免把任意串拼进 broker 的 URL 路径。
    if (!/^[0-9a-f-]{36}$/i.test(uploadId)) {
      return c.json({ error: "invalid uploadId" }, 400);
    }

    let res: Response;
    try {
      res = await doFetch(`${deps.base}/v1/uploads/${uploadId}/commit`, {
        method: "POST",
        headers: brokerHeaders,
      });
    } catch (e) {
      logger.warn({ session: name, err: (e as Error).message }, "broker unreachable");
      return c.json({ error: "upload broker unreachable" }, 502);
    }

    const text = await res.text();
    if (!res.ok) {
      logger.warn({ session: name, status: res.status, body: text.slice(0, 200) }, "broker commit failed");
      return new Response(text, {
        status: res.status,
        headers: { "content-type": "application/json" },
      });
    }
    const parsed = JSON.parse(text) as { path?: string; size?: number };
    logger.info({ session: name, path: parsed.path, size: parsed.size }, "upload committed via TOS");
    return c.json({ ok: true, path: parsed.path });
  });

  return r;
}
