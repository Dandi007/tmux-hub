import { hubFetch } from "../hub-fetch";

export async function renameSession(from: string, to: string): Promise<void> {
  const r = await hubFetch(`/sessions/${encodeURIComponent(from)}/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => r.statusText);
    throw new Error(text || `HTTP ${r.status}`);
  }
}
