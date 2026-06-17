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

export type SequentialUploadResult = {
  paths: string[];
  errors: { name: string; message: string }[];
};

/**
 * Upload multiple files one at a time, preserving selection order.
 * Sequential (not concurrent) so paths stay ordered and the server isn't
 * hammered. A single file's failure is isolated — it's collected into
 * `errors` and the remaining files still upload.
 */
export async function uploadFilesSequential(
  session: string,
  files: File[],
  upload: (s: string, f: File) => Promise<string> = uploadFileForSession,
): Promise<SequentialUploadResult> {
  const paths: string[] = [];
  const errors: { name: string; message: string }[] = [];
  for (const file of files) {
    try {
      paths.push(await upload(session, file));
    } catch (e) {
      errors.push({ name: file.name, message: (e as Error).message });
    }
  }
  return { paths, errors };
}
