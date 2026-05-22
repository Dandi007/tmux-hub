import type { MiddlewareHandler } from "hono";
import { loadOrCreateSecret, safeEqual } from "./secret";
import { verifyCfAccessJwt } from "./cf-access";

const SECRET = loadOrCreateSecret();

// PUBLIC_PATHS bypass auth entirely. PWA install detection (manifest + SW
// bootstrap) needs to work even before the SPA has called /system/auth-check
// to acquire the hub.secret; Cloudflare Access still wraps everything at the
// edge in production, so this is not weakening the trust boundary.
const PUBLIC_PATHS = new Set([
  "/system/health",
  "/manifest.webmanifest",
  "/sw.js",
]);

function isReadOnly(method: string, path: string): boolean {
  if (method !== "GET") return false;
  if (path === "/" || path === "/templates" || path === "/events") return true;
  if (path === "/system/auth-check") return true;
  if (path === "/manifest.webmanifest" || path === "/sw.js") return true;
  if (path.startsWith("/web/") || path.startsWith("/assets/")) return true;
  // PWA icons and other static files emitted by Vite into dist/web/ are
  // referenced from manifest/index.html at the site root.
  if (/^\/(pwa-|favicon-|apple-touch-icon-|registerSW\.js$)/.test(path)) return true;
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

  const cfJwt = c.req.header("cf-access-jwt-assertion");
  const localSecret = c.req.header("x-hub-secret");

  const cfOk = cfJwt ? await verifyCfAccessJwt(cfJwt).catch(() => null) : null;
  const localOk = !!localSecret && safeEqual(localSecret, SECRET);
  const authed = !!cfOk || localOk;

  if (isReadOnly(c.req.method, path)) {
    if (authed) c.set("identity", cfOk?.email ?? "local-secret");
    return next();
  }

  if (!authed) return c.json({ error: "unauthorized" }, 401);
  c.set("identity", cfOk?.email ?? "local-secret");
  return next();
};
