// gate-id 身份验签。
//
// edge-gateway 的 `gated` Caddy 片段经 forward_auth /verify 向上游注入两个头：
//   X-Auth-User-Id: <uid>
//   X-Auth-Sig:     `${ts}.${hmac_sha256(GATE_INJECT_KEY, "uid|app|ts")}`
// 其中 app = 访问域名的第一段（hub.qinglinzhang.top → "hub"，见 gate-auth authz.go:appFromHost）。
//
// 本模块与 gate-auth inject.go:signIdentity / todo-pwa src/auth.ts 对称——
// 共享同一个 GATE_INJECT_KEY，验签即可信任 uid 为已鉴权用户身份。
import { createHmac, timingSafeEqual } from "node:crypto";

// 本应用在 gate-auth 里的 app 名 = 域名第一段。
export const GATE_APP = "hub";

// 默认时钟偏移容忍（秒），与 gate-auth /verify、todo-pwa 一致。
export const GATE_SKEW_SECONDS = 300;

/**
 * 验证 gate-id 注入的签名身份。
 * @returns 验签通过返回 true（uid 可信）；任何缺失/过期/不匹配返回 false。
 */
export function verifyGateIdentity(
  uid: string,
  app: string,
  sig: string,
  key: string,
  now: number,
  skew: number,
): boolean {
  // !app guard: an empty app would sign `uid||ts` (no app binding) — reject it so
  // the app-scoping (hub vs todo) can never be silently weakened by a bad caller.
  if (!uid || !app || !sig || !key) return false;
  const [tsStr] = sig.split(".", 2);
  const ts = Number(tsStr);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > skew) return false;
  const want =
    `${tsStr}.` +
    createHmac("sha256", key).update(`${uid}|${app}|${tsStr}`).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  // 长度相等才比较：timingSafeEqual 要求等长，且 hex 摘要长度固定。
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 从请求头解析并验证 gate-id 身份。
 * @returns 验签通过返回 uid；缺头/key 未配置/验签失败返回 null（让上层回退到其它鉴权）。
 */
export function gateIdentityFromHeaders(
  headers: { uid: string | undefined; sig: string | undefined },
  key: string,
  now: number,
  skew: number = GATE_SKEW_SECONDS,
): string | null {
  const { uid, sig } = headers;
  if (!uid || !sig || !key) return null;
  return verifyGateIdentity(uid, GATE_APP, sig, key, now, skew) ? uid : null;
}
