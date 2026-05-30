import type { MiddlewareHandler } from "hono";
import { loadOrCreateAdminSecret, safeEqual } from "./secret";
import { createLogger } from "./logger";

const logger = createLogger("admin-gate");

let _adminSecret: string | null = null;
function adminSecret(): string {
  if (!_adminSecret) _adminSecret = loadOrCreateAdminSecret();
  return _adminSecret;
}

// adminGate is a dedicated middleware for the POST /sessions launch endpoint.
// It requires a local-only admin secret (never returned by any endpoint) and
// defensively rejects requests that arrive via Cloudflare tunnels.
export const adminGate: MiddlewareHandler = async (c, next) => {
  const secret = c.req.header("x-hub-admin-secret");

  // Defense-in-depth: reject any request that came through a tunnel
  if (c.req.header("cf-access-jwt-assertion") || c.req.header("x-forwarded-for")) {
    logger.warn("admin gate: tunneled request rejected (cf-access or x-forwarded-for present)");
    return c.json({ error: "forbidden: not available via tunnel" }, 403);
  }

  if (!secret || !safeEqual(secret, adminSecret())) {
    logger.warn("admin gate: unauthorized");
    return c.json({ error: "unauthorized" }, 401);
  }

  return next();
};