import { describe, test, expect, mock } from "bun:test";
import {
  uploadFileForSession,
  uploadFilesSequential,
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

describe("uploadFilesSequential", () => {
  const f = (name: string) => new File([new Uint8Array(4)], name, { type: "image/png" });

  test("uploads files one at a time, in order, never concurrently", async () => {
    let inFlight = 0;
    const callOrder: string[] = [];
    const upload = mock(async (_s: string, file: File) => {
      callOrder.push(file.name);
      inFlight++;
      expect(inFlight).toBe(1); // sequential: no overlap
      await Promise.resolve();
      inFlight--;
      return `/abs/${file.name}`;
    });
    const { paths, errors } = await uploadFilesSequential(
      "sess1",
      [f("a.png"), f("b.png"), f("c.png")],
      upload,
    );
    expect(callOrder).toEqual(["a.png", "b.png", "c.png"]);
    expect(paths).toEqual(["/abs/a.png", "/abs/b.png", "/abs/c.png"]);
    expect(errors).toEqual([]);
  });

  test("isolates per-file failure, keeps remaining successes in order", async () => {
    const upload = mock(async (_s: string, file: File) => {
      if (file.name === "bad.png") throw new Error("too large");
      return `/abs/${file.name}`;
    });
    const { paths, errors } = await uploadFilesSequential(
      "sess1",
      [f("ok1.png"), f("bad.png"), f("ok2.png")],
      upload,
    );
    expect(paths).toEqual(["/abs/ok1.png", "/abs/ok2.png"]);
    expect(errors).toEqual([{ name: "bad.png", message: "too large" }]);
  });
});
