import type { MiddlewareHandler } from "hono";
import { loadOrCreateSecret, safeEqual } from "./secret";
import { verifyCfAccessJwt } from "./cf-access";
import { gateIdentityFromHeaders } from "./identity";
import { gateInjectKey } from "./config";
import { createLogger } from "./logger";

const logger = createLogger("auth");

let _secret: string | null = null;
function hubSecret(): string {
  if (!_secret) _secret = loadOrCreateSecret();
  return _secret;
}

/**
 * Reset cached secret — test-only, allows re-reading from a new env path.
 * @internal Test-only helper for integration tests that swap the secret path.
 */
export function _resetSecretForTest(): void {
  _secret = null;
}

// PUBLIC_PATHS bypass auth entirely. PWA install detection (manifest + SW
// bootstrap) needs to work even before the SPA has called /system/auth-check
// to acquire the hub.secret; Cloudflare Access still wraps everything at the
// edge in production, so this is not weakening the trust boundary.
const PUBLIC_PATHS = new Set([
  "/system/health",
  "/manifest.webmanifest",
  "/sw.js",
]);

const STATIC_EXT = /\.(html|js|css|json|map|svg|png|jpg|jpeg|webp|avif|ico|woff2?|ttf|webmanifest)$/;

function isReadOnly(method: string, path: string): boolean {
  if (method !== "GET") return false;
  if (path === "/" || path === "/templates" || path === "/events") return true;
  if (path === "/system/auth-check") return true;
  if (path.startsWith("/assets/")) return true;
  if (STATIC_EXT.test(path)) return true;
  return false;
}

declare module "hono" {
  interface ContextVariableMap {
    identity: string;
  }
}

export const authGate: MiddlewareHandler = async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (PUBLIC_PATHS.has(path)) return next();

  // The launch endpoint POST /sessions has its own dedicated adminGate (local
  // admin secret, tunnel-rejected) and MUST bypass the standard authGate: an
  // admin-secret-only caller holds hub.admin.secret but not hub.secret, so
  // authGate would 401 it before adminGate ever runs. adminGate is the sole —
  // and stricter — gate for this exact path. Scoped to the exact path so the
  // /sessions/:name/* control routes stay under authGate.
  if (path === "/sessions") return next();

  const cfJwt = c.req.header("cf-access-jwt-assertion");
  const localSecret = c.req.header("x-hub-secret");

  // gate-id 注入身份：edge 的 gated 片段经 forward_auth /verify 注入 X-Auth-User-Id +
  // X-Auth-Sig。验签过即可信 uid 为已鉴权用户。key 未配置时 gateUid 恒为 null（惰化），
  // 行为回退到既有的 cf-access / hub.secret，向后兼容。
  const gateUid = gateIdentityFromHeaders(
    { uid: c.req.header("x-auth-user-id"), sig: c.req.header("x-auth-sig") },
    gateInjectKey(),
    Math.floor(Date.now() / 1000),
  );

  const cfOk = cfJwt ? await verifyCfAccessJwt(cfJwt).catch(() => null) : null;
  const localOk = !!localSecret && safeEqual(localSecret, hubSecret());
  const authed = !!gateUid || !!cfOk || localOk;

  // 身份优先级：gate-id 真实 uid > CF email > 本地 secret 占位。
  const identity = gateUid ?? cfOk?.email ?? "local-secret";

  if (isReadOnly(c.req.method, path)) {
    // NOTE: read-only paths pass through even when unauthenticated; identity is
    // only set when authed. Downstream read handlers MUST NOT treat the presence
    // of c.get("identity") as proof of auth, nor its absence as a hard gate —
    // this branch is intentionally anonymous-readable. Per-user authorization
    // (e.g. owner-scoped data) must re-check auth explicitly, not infer it here.
    if (authed) c.set("identity", identity);
    return next();
  }

  if (!authed) {
    logger.warn({ method: c.req.method, path }, "auth rejected: unauthorized write");
    return c.json({ error: "unauthorized" }, 401);
  }
  c.set("identity", identity);
  return next();
};

export { adminGate } from "./admin-gate";
