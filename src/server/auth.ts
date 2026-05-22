import type { MiddlewareHandler } from "hono";
import { loadOrCreateSecret, safeEqual } from "./secret";
import { verifyCfAccessJwt } from "./cf-access";

const SECRET = loadOrCreateSecret();

const PUBLIC_PATHS = new Set(["/system/health"]);

function isReadOnly(method: string, path: string): boolean {
  if (method !== "GET") return false;
  return (
    path === "/" ||
    path === "/templates" ||
    path === "/events" ||
    path === "/system/auth-check" ||
    path.startsWith("/web/") ||
    path.startsWith("/assets/")
  );
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
