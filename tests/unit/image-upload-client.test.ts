import { describe, test, expect, mock } from "bun:test";
import {
  IMAGE_MIME_WHITELIST_CLIENT,
  MAX_IMAGE_BYTES_CLIENT,
  isImageFile,
  uploadImageForSession,
} from "../../src/web/upload/image-upload";

describe("IMAGE_MIME_WHITELIST_CLIENT", () => {
  test("matches server-side whitelist", () => {
    expect(new Set(IMAGE_MIME_WHITELIST_CLIENT)).toEqual(
      new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic"]),
    );
  });
});

describe("isImageFile", () => {
  test("accepts whitelisted mimes", () => {
    for (const mime of IMAGE_MIME_WHITELIST_CLIENT) {
      const f = new File([new Uint8Array(1)], "x", { type: mime });
      expect(isImageFile(f)).toBe(true);
    }
  });
  test("rejects unknown mimes", () => {
    const f = new File([new Uint8Array(1)], "x.txt", { type: "text/plain" });
    expect(isImageFile(f)).toBe(false);
  });
});

describe("uploadImageForSession", () => {
  test("rejects oversized file without calling fetcher", async () => {
    const big = new File([new Uint8Array(MAX_IMAGE_BYTES_CLIENT + 1)], "big.png", { type: "image/png" });
    const fetcher = mock(async () => new Response("{}"));
    await expect(uploadImageForSession("s", big, fetcher)).rejects.toThrow(/too large/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("rejects bad mime without calling fetcher", async () => {
    const bad = new File([new Uint8Array(10)], "x.txt", { type: "text/plain" });
    const fetcher = mock(async () => new Response("{}"));
    await expect(uploadImageForSession("s", bad, fetcher)).rejects.toThrow(/unsupported/i);
    expect(fetcher).not.toHaveBeenCalled();
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
    const path = await uploadImageForSession("sess1", file, fetcher);
    expect(path).toBe("/abs/foo.png");
  });

  test("non-200 throws with body text", async () => {
    const file = new File([new Uint8Array(10)], "ok.png", { type: "image/png" });
    const fetcher = mock(async () => new Response("nope", { status: 413 }));
    await expect(uploadImageForSession("sess1", file, fetcher)).rejects.toThrow(/nope/);
  });
});
