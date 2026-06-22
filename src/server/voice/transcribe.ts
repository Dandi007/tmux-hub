export interface VoiceDeps { blobBase: string; asrBase: string; fetchFn?: (url: string, init?: RequestInit) => Promise<Response>; }

// mp-blob 的 blob_id 是 URI 形式 `blob://<hex>`（asr 端会自行 resolve scheme）。
// 但 mp-blob 的 GET /blob/:hex 要裸 hex——直接拿 blob_id 去 encodeURIComponent 会把
// `blob://` 一起编码成 `blob%3A%2F%2F` → 404。回放取 blob 前必须先剥 scheme。
export function blobIdToHex(blobId: string): string {
  return blobId.replace(/^blob:\/\//, "");
}

// 音频字节 → mp-blob 拿 blob_id → mp-asr 拿整段 text。任一上游非 2xx 抛错（由端点转 502）。
// 返回 audioBlobId 复用同一次上传的 blob（语音按账号保存时无需二次上传原始音频）。
export async function transcribeAudio(bytes: Uint8Array, deps: VoiceDeps): Promise<{ text: string; audioBlobId: string }> {
  const doFetch = deps.fetchFn ?? fetch;
  const put = await doFetch(`${deps.blobBase}/blob`, { method: "PUT", body: bytes as BodyInit });
  if (!put.ok) throw new Error(`blob upload failed: ${put.status}`);
  const { blob_id } = (await put.json()) as { blob_id: string };
  const asr = await doFetch(`${deps.asrBase}/asr`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audio_blob_id: blob_id }),
  });
  if (!asr.ok) throw new Error(`asr failed: ${asr.status}`);
  const data = (await asr.json()) as { text?: string };
  return { text: data.text ?? "", audioBlobId: blob_id };
}
