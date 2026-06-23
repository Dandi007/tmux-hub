// mp-blob 的 blob_id 是 URI 形式 `blob://<hex>`。
// mp-blob 的 GET /blob/:hex 要裸 hex——直接拿 blob_id 去 encodeURIComponent 会把
// `blob://` 一起编码成 `blob%3A%2F%2F` → 404。回放取 blob 前必须先剥 scheme。
// 注：音频转写编排（blob→asr→clean）已下沉到 voice-intake 服务；hub 侧只保留回放用的 blobIdToHex。
export function blobIdToHex(blobId: string): string {
  return blobId.replace(/^blob:\/\//, "");
}
