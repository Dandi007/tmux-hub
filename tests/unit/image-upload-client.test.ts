import { describe, test, expect, mock } from "bun:test";
import {
  uploadDirectToHub,
  uploadFileForSession,
  uploadFilesSequential,
  uploadViaBroker,
} from "../../src/web/upload/image-upload";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const INIT = {
  uploadId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  endpoint: "https://bucket.tos-s3-cn-beijing.volces.com/",
  fields: { key: "u/tmux-hub/2026-08-10/uuid.png", Policy: "p", "X-Amz-Signature": "sig" },
  key: "u/tmux-hub/2026-08-10/uuid.png",
  maxBytes: 10,
  expiresAt: "2026-08-10T07:00:00.000Z",
};

describe("uploadDirectToHub（老路径：multipart 进 hub）", () => {
  test("accepts any file type (no client-side mime rejection)", async () => {
    const txtFile = new File([new Uint8Array(10)], "x.txt", { type: "text/plain" });
    const fetcher = mock(async () => json({ ok: true, path: "/abs/x.txt" }));
    expect(await uploadDirectToHub("s", txtFile, fetcher)).toBe("/abs/x.txt");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("happy path: posts multipart + returns path", async () => {
    const file = new File([new Uint8Array(10)], "ok.png", { type: "image/png" });
    const fetcher = mock(async (input: string, init?: RequestInit) => {
      expect(input).toBe("/sessions/sess1/upload-image");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeInstanceOf(FormData);
      return json({ ok: true, path: "/abs/foo.png" });
    });
    expect(await uploadDirectToHub("sess1", file, fetcher)).toBe("/abs/foo.png");
  });

  test("non-200 throws with body text", async () => {
    const file = new File([new Uint8Array(10)], "ok.png", { type: "image/png" });
    const fetcher = mock(async () => new Response("nope", { status: 413 }));
    await expect(uploadDirectToHub("sess1", file, fetcher)).rejects.toThrow(/nope/);
  });
});

describe("uploadViaBroker（TOS 直传）", () => {
  const file = () => new File([new Uint8Array(10)], "ok.png", { type: "image/png" });

  test("init → 直传存储 → commit，返回本地路径", async () => {
    const seen: string[] = [];
    const fetcher = mock(async (input: string, init?: RequestInit) => {
      seen.push(input);
      if (input.endsWith("/upload-init")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          filename: "ok.png",
          size: 10,
          mime: "image/png",
        });
        return json(INIT);
      }
      expect(JSON.parse(String(init?.body))).toEqual({ uploadId: INIT.uploadId });
      return json({ ok: true, path: "/abs/via-tos.png" });
    });
    const rawFetch = mock(async () => new Response(null, { status: 204 }));

    expect(await uploadViaBroker("sess1", file(), fetcher, rawFetch)).toBe("/abs/via-tos.png");
    expect(seen).toEqual(["/sessions/sess1/upload-init", "/sessions/sess1/upload-commit"]);
  });

  test("直传用裸 fetch，绝不把 hub 凭证发给存储", async () => {
    const fetcher = mock(async (input: string) =>
      input.endsWith("/upload-init") ? json(INIT) : json({ ok: true, path: "/abs/x.png" }),
    );
    let storageUrl = "";
    let storageForm: FormData | null = null;
    const rawFetch = mock(async (input: string, init?: RequestInit) => {
      storageUrl = input;
      storageForm = init?.body as FormData;
      // 直传请求不得携带任何 hub 侧 header
      expect(init?.headers).toBeUndefined();
      return new Response(null, { status: 204 });
    });

    await uploadViaBroker("sess1", file(), fetcher, rawFetch);
    expect(storageUrl).toBe(INIT.endpoint);
    // 签名字段原样带上，file 排在最后且带 filename
    const entries = [...(storageForm as unknown as FormData).keys()];
    expect(entries).toEqual(["key", "Policy", "X-Amz-Signature", "file"]);
  });

  test("存储拒绝时抛出 TOS 的错误码", async () => {
    const fetcher = mock(async () => json(INIT));
    const rawFetch = mock(
      async () =>
        new Response("<Error><Code>EntityTooLarge</Code></Error>", { status: 400 }),
    );
    await expect(uploadViaBroker("s", file(), fetcher, rawFetch)).rejects.toThrow(/EntityTooLarge/);
  });
});

describe("uploadFileForSession（直传优先 + 降级）", () => {
  const file = () => new File([new Uint8Array(10)], "ok.png", { type: "image/png" });

  test("broker 可用时走直传，不碰老端点", async () => {
    const seen: string[] = [];
    const fetcher = mock(async (input: string) => {
      seen.push(input);
      return input.endsWith("/upload-init") ? json(INIT) : json({ ok: true, path: "/abs/tos.png" });
    });
    globalThis.fetch = mock(async () => new Response(null, { status: 204 })) as typeof fetch;

    expect(await uploadFileForSession("sess1", file(), fetcher)).toBe("/abs/tos.png");
    expect(seen.some((s) => s.endsWith("/upload-image"))).toBe(false);
  });

  test("broker 未启用（501）时降级回老端点", async () => {
    const seen: string[] = [];
    const fetcher = mock(async (input: string) => {
      seen.push(input);
      if (input.endsWith("/upload-init")) return new Response("upload broker disabled", { status: 501 });
      return json({ ok: true, path: "/abs/legacy.png" });
    });
    expect(await uploadFileForSession("sess1", file(), fetcher)).toBe("/abs/legacy.png");
    expect(seen).toEqual(["/sessions/sess1/upload-init", "/sessions/sess1/upload-image"]);
  });

  test("直传到存储失败时也降级", async () => {
    const seen: string[] = [];
    const fetcher = mock(async (input: string) => {
      seen.push(input);
      if (input.endsWith("/upload-init")) return json(INIT);
      return json({ ok: true, path: "/abs/legacy.png" });
    });
    globalThis.fetch = mock(async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;

    expect(await uploadFileForSession("sess1", file(), fetcher)).toBe("/abs/legacy.png");
    expect(seen[seen.length - 1]).toBe("/sessions/sess1/upload-image");
  });

  test("会话已消失不降级——老路径同样会失败，重试无意义", async () => {
    const seen: string[] = [];
    const fetcher = mock(async (input: string) => {
      seen.push(input);
      return new Response(JSON.stringify({ error: "session not found" }), { status: 410 });
    });
    await expect(uploadFileForSession("gone", file(), fetcher)).rejects.toThrow(/session not found/);
    expect(seen).toEqual(["/sessions/gone/upload-init"]);
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
