export interface VoiceDeps { blobBase: string; asrBase: string; fetchFn?: (url: string, init?: RequestInit) => Promise<Response>; }

// 音频字节 → mp-blob 拿 blob_id → mp-asr 拿整段 text。任一上游非 2xx 抛错（由端点转 502）。
export async function transcribeAudio(bytes: Uint8Array, deps: VoiceDeps): Promise<{ text: string }> {
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
  return { text: data.text ?? "" };
}
