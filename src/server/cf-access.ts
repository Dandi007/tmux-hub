// Stub for Cloudflare Access JWT verification. Real implementation belongs to spike S3
// (see work folder /Volumes/Data/code/self/tmux-hub-spikes). Until that lands, this returns null
// for any input, so the loopback secret is the only path that authenticates state-changing endpoints.
// Stage B (public deployment) MUST replace this with real JWT verification before going live.

export type CfAccessIdentity = { email: string; sub: string; aud: string };

export async function verifyCfAccessJwt(_jwt: string): Promise<CfAccessIdentity | null> {
  if (process.env.TMUX_HUB_CF_ACCESS_DISABLED === "1") return null;
  // No-op until S3 spike implementation is ported in.
  return null;
}
