import { test, expect } from "bun:test";
import { fetchIntakeSse, pipeIntakeSse, type IntakeDone } from "./intake-client";

test("fetchIntakeSse: 带 Accept SSE 打到 /transcribe?card=", async () => {
  let seen = "";
  const fetchFn = (async (url: string, init: RequestInit) => {
    seen = url;
    expect((init.headers as Record<string, string>)["Accept"]).toBe("text/event-stream");
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  await fetchIntakeSse(new Uint8Array([1]), "hub-polish", { intakeBase: "http://127.0.0.1:8099", fetchFn });
  expect(seen).toBe("http://127.0.0.1:8099/transcribe?card=hub-polish");
});

test("pipeIntakeSse: 原样转发字节且旁路抓到 done", async () => {
  const enc = new TextEncoder();
  const upstream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode("event: uploaded\ndata: {\"audio_blob_id\":\"blob://x\"}\n\n"));
      c.enqueue(enc.encode("event: done\ndata: {\"text\":\"润色后\",\"raw_text\":\"原始\",\"audio_blob_id\":\"blob://x\",\"t\":{\"transcribeMs\":1,\"cleanMs\":2,\"totalMs\":3}}\n\n"));
      c.close();
    },
  });
  let captured: IntakeDone | null = null;
  const piped = pipeIntakeSse(upstream, (d) => { captured = d; });
  const out = await new Response(piped).text();
  expect(out).toContain("event: uploaded");
  expect(out).toContain("event: done");
  expect(captured!.text).toBe("润色后");
  expect(captured!.audio_blob_id).toBe("blob://x");
});
