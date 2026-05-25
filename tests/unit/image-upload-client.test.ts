import { describe, test, expect, mock } from "bun:test";
import {
  uploadFileForSession,
} from "../../src/web/upload/image-upload";

describe("uploadFileForSession", () => {
  test("accepts any file type (no client-side mime rejection)", async () => {
    const txtFile = new File([new Uint8Array(10)], "x.txt", { type: "text/plain" });
    const fetcher = mock(async () =>
      new Response(JSON.stringify({ ok: true, path: "/abs/x.txt" }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    );
    const path = await uploadFileForSession("s", txtFile, fetcher);
    expect(path).toBe("/abs/x.txt");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("happy path: posts multipart + returns path", async () => {
    const file = new File([new Uint8Array(10)], "ok.png", { type: "image/png" });
    const fetcher = mock(async (input: string, init?: RequestInit) => {
      expect(input).toBe("/sessions/sess1/upload-image");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeInstanceOf(FormData);
      return new Response(JSON.stringify({ ok: true, path: "/abs/foo.png" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    const path = await uploadFileForSession("sess1", file, fetcher);
    expect(path).toBe("/abs/foo.png");
  });

  test("non-200 throws with body text", async () => {
    const file = new File([new Uint8Array(10)], "ok.png", { type: "image/png" });
    const fetcher = mock(async () => new Response("nope", { status: 413 }));
    await expect(uploadFileForSession("sess1", file, fetcher)).rejects.toThrow(/nope/);
  });
});
