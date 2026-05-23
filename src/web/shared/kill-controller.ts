import { hubFetch } from "../hub-fetch";

export async function killSession(name: string): Promise<void> {
  const r = await hubFetch(`/sessions/${encodeURIComponent(name)}/kill`, {
    method: "POST",
    headers: { "x-hub-confirm": "kill" },
  });
  if (!r.ok) {
    const text = await r.text().catch(() => r.statusText);
    throw new Error(text || `HTTP ${r.status}`);
  }
}
