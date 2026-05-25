import { hubFetch } from "../hub-fetch";

export const FILE_ACCEPT_ATTR = "*/*";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export async function uploadFileForSession(
  session: string,
  file: File,
  fetcher: Fetcher = hubFetch,
): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const r = await fetcher(`/sessions/${encodeURIComponent(session)}/upload-image`, {
    method: "POST",
    body: form,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => `HTTP ${r.status}`);
    throw new Error(text || `HTTP ${r.status}`);
  }
  const body = (await r.json()) as { ok: boolean; path: string };
  return body.path;
}
