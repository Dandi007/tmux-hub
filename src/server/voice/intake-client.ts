// 调 voice-intake(:8099) 的 SSE，并把上游事件流原样转发给 hub 自己的客户端；
// 旁路解析 done 事件供按账号落库（不阻断转发）。
export interface IntakeDone {
  text: string;
  raw_text: string;
  audio_blob_id: string;
  t: { transcribeMs: number; cleanMs: number; totalMs: number };
}

export interface IntakeClientDeps { intakeBase: string; fetchFn?: typeof fetch }

export async function fetchIntakeSse(bytes: Uint8Array, card: string, deps: IntakeClientDeps): Promise<Response> {
  const doFetch = deps.fetchFn ?? fetch;
  return doFetch(`${deps.intakeBase}/transcribe?card=${encodeURIComponent(card)}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", Accept: "text/event-stream" },
    body: bytes as BodyInit,
  });
}

export function pipeIntakeSse(upstream: ReadableStream<Uint8Array>, onDone: (d: IntakeDone) => void): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const { done, value } = await reader.read();
      if (done) { ctrl.close(); return; }
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = /event: (.*)/.exec(block)?.[1]?.trim();
        const dm = /data: (.*)/.exec(block)?.[1];
        if (ev === "done" && dm) { try { onDone(JSON.parse(dm) as IntakeDone); } catch { /* 旁路解析失败不影响转发 */ } }
      }
      ctrl.enqueue(value); // 原样转发上游字节（verbatim passthrough）
    },
    cancel() { void reader.cancel(); },
  });
}
