import { hubFetch } from "../hub-fetch";

export const FILE_ACCEPT_ATTR = "*/*";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type InitResponse = {
  uploadId: string;
  endpoint: string;
  fields: Record<string, string>;
  key: string;
  maxBytes: number;
  expiresAt: string;
};

/**
 * 直传 TOS。**必须用裸 fetch，不能用 hubFetch** —— hubFetch 会带上 X-Hub-Secret，
 * 那是 hub 的凭证，绝不能发到第三方存储。
 */
async function postToStorage(
  init: InitResponse,
  file: File,
  rawFetch: Fetcher = (i, o) => fetch(i, o),
): Promise<void> {
  const form = new FormData();
  // 签名字段必须原样、且排在 file 之前；file part 必须带 filename，
  // 否则 TOS 判「POST requires exactly one file upload per request」。
  for (const [k, v] of Object.entries(init.fields)) form.append(k, v);
  form.append("file", file, file.name || "upload.bin");

  const r = await rawFetch(init.endpoint, { method: "POST", body: form });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1] ?? `HTTP ${r.status}`;
    throw new Error(`storage rejected upload: ${code}`);
  }
}

/**
 * TOS 直传路径：init 取签名 → 浏览器直传存储 → commit 让服务端拉回落盘。
 * 字节不经过 hub，也就不经过 ECS 的公网出口。
 */
export async function uploadViaBroker(
  session: string,
  file: File,
  fetcher: Fetcher = hubFetch,
  rawFetch: Fetcher = (i, o) => fetch(i, o),
): Promise<string> {
  const initRes = await fetcher(`/sessions/${encodeURIComponent(session)}/upload-init`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename: file.name, size: file.size, mime: file.type }),
  });
  if (!initRes.ok) {
    const text = await initRes.text().catch(() => "");
    throw new Error(text || `init failed: HTTP ${initRes.status}`);
  }
  const init = (await initRes.json()) as InitResponse;

  await postToStorage(init, file, rawFetch);

  const commitRes = await fetcher(`/sessions/${encodeURIComponent(session)}/upload-commit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uploadId: init.uploadId }),
  });
  if (!commitRes.ok) {
    const text = await commitRes.text().catch(() => "");
    throw new Error(text || `commit failed: HTTP ${commitRes.status}`);
  }
  const body = (await commitRes.json()) as { ok: boolean; path: string };
  return body.path;
}

/** 老路径：multipart 进 hub 再落盘。保留作为降级，也是 broker 未启用时的唯一路径。 */
export async function uploadDirectToHub(
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

/**
 * 优先直传，失败降级回老路径。
 *
 * 降级是刻意的：broker 没起、TOS 不通、所在网络挡了对象存储域名——这些都不该
 * 让用户传不了图。上传是低频操作，多一次往返的代价远小于传不上去。
 * 只有 410（会话没了）不降级：老路径同样会失败，重试没有意义。
 */
export async function uploadFileForSession(
  session: string,
  file: File,
  fetcher: Fetcher = hubFetch,
): Promise<string> {
  try {
    return await uploadViaBroker(session, file, fetcher);
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (/session not found/i.test(msg)) throw e;
    console.warn("[upload] direct-to-storage failed, falling back to hub upload:", msg);
    return uploadDirectToHub(session, file, fetcher);
  }
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
