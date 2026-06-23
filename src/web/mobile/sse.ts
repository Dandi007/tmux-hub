// 浏览器侧 SSE 解析：读 ReadableStream，按 \n\n 切事件块，逐个回调 (event, data)。
export async function readSse(body: ReadableStream<Uint8Array>, on: (event: string, data: unknown) => void): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = /event: (.*)/.exec(block)?.[1]?.trim();
      const dm = /data: (.*)/.exec(block)?.[1];
      if (!ev) continue;
      let data: unknown = null;
      if (dm) { try { data = JSON.parse(dm); } catch { /* ignore */ } }
      on(ev, data);
    }
  }
}
