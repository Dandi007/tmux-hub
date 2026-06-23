import { test, expect } from "bun:test";
import { readSse } from "./sse";

test("readSse: 跨 chunk 切分事件并回调", async () => {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode("event: transcribing\ndata: {\"seg_total\":null}\n\nevent: clea"));
      c.enqueue(enc.encode("ning\ndata: {\"card\":\"hub-polish\"}\n\nevent: done\ndata: {\"text\":\"x\"}\n\n"));
      c.close();
    },
  });
  const got: string[] = [];
  await readSse(body, (ev) => got.push(ev));
  expect(got).toEqual(["transcribing", "cleaning", "done"]);
});
