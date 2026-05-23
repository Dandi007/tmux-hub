import { hubFetch } from "../hub-fetch";

export const IMAGE_MIME_WHITELIST_CLIENT = [
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/heic",
] as const;

export const IMAGE_ACCEPT_ATTR =
  "image/png,image/jpeg,image/gif,image/webp,image/heic";

export function isImageFile(f: File | Blob): boolean {
  return (IMAGE_MIME_WHITELIST_CLIENT as readonly string[]).includes(f.type);
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export async function uploadImageForSession(
  session: string,
  file: File,
  fetcher: Fetcher = hubFetch,
): Promise<string> {
  // Size is enforced server-side (TMUX_HUB_MAX_IMAGE_BYTES env). Client used to
  // pre-check, but that hardcoded the limit and drifted from the deployer's
  // config. Server's 413 surfaces via toast on failure.
  if (!isImageFile(file)) {
    throw new Error(`unsupported mime: ${file.type || "(unknown)"}`);
  }
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
