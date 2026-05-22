let cached: string | null = null;

async function getSecret(): Promise<string | null> {
  if (cached) return cached;
  const stored = typeof sessionStorage !== "undefined" ? sessionStorage.getItem("hub.secret") : null;
  if (stored) { cached = stored; return stored; }
  const r = await fetch("/system/auth-check", { credentials: "include" });
  if (!r.ok) return null;
  const body = (await r.json()) as { secret?: string };
  if (!body.secret) return null;
  sessionStorage.setItem("hub.secret", body.secret);
  cached = body.secret;
  return body.secret;
}

export async function hubFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const secret = await getSecret();
  const headers = new Headers(init.headers ?? {});
  if (secret) headers.set("X-Hub-Secret", secret);
  return fetch(input, { ...init, headers, credentials: "include" });
}

export async function hubWsUrl(path: string): Promise<string> {
  const secret = await getSecret();
  const u = new URL(path, location.href);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  if (secret) u.searchParams.set("token", secret);
  return u.toString();
}
