import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildImageUploadRoutes } from "../../src/server/image-upload";

// Tiny valid PNG (1x1 red pixel) for fixture
const RED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

const SESSION = "user-iu-" + Date.now().toString().slice(-8);

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "tmux-hub-img-"));
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function makeApp(opts?: { sessionExists?: (name: string) => boolean }) {
  const app = new Hono();
  app.route("/", buildImageUploadRoutes({
    imageDir: tmpRoot,
    maxBytes: 1024 * 1024,
    sessionExists: opts?.sessionExists ?? (() => true),
  }));
  return app;
}

function pngFile(name = "x.png"): File {
  const bytes = Buffer.from(RED_PNG_B64, "base64");
  return new File([bytes], name, { type: "image/png" });
}

function multipart(file: File): FormData {
  const fd = new FormData();
  fd.append("file", file);
  return fd;
}

describe("POST /sessions/:name/upload-image", () => {
  test("200 + path returned, file written on disk with correct bytes", async () => {
    const app = makeApp();
    const fd = multipart(pngFile());
    const r = await app.fetch(new Request(`http://localhost/sessions/${SESSION}/upload-image`, {
      method: "POST", body: fd,
    }));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; path: string };
    expect(body.ok).toBe(true);
    expect(body.path.startsWith(tmpRoot + "/")).toBe(true);
    expect(body.path.endsWith(".png")).toBe(true);
    const st = await stat(body.path);
    expect(st.isFile()).toBe(true);
    const written = await readFile(body.path);
    expect(written.byteLength).toBe(Buffer.from(RED_PNG_B64, "base64").byteLength);
  });

  test("two uploads of the same bytes produce two distinct UUIDs", async () => {
    const app = makeApp();
    const r1 = await app.fetch(new Request(`http://localhost/sessions/${SESSION}/upload-image`, {
      method: "POST", body: multipart(pngFile()),
    }));
    const r2 = await app.fetch(new Request(`http://localhost/sessions/${SESSION}/upload-image`, {
      method: "POST", body: multipart(pngFile()),
    }));
    const p1 = ((await r1.json()) as { path: string }).path;
    const p2 = ((await r2.json()) as { path: string }).path;
    expect(p1).not.toBe(p2);
  });

  test("accepts non-image file types (e.g. text/plain)", async () => {
    const app = makeApp();
    const txtFile = new File([Buffer.from("hello")], "x.txt", { type: "text/plain" });
    const fd = multipart(txtFile);
    const r = await app.fetch(new Request(`http://localhost/sessions/${SESSION}/upload-image`, {
      method: "POST", body: fd,
    }));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; path: string };
    expect(body.ok).toBe(true);
    expect(body.path.endsWith(".txt")).toBe(true);
  });

  test("accepts PDF uploads", async () => {
    const app = makeApp();
    const pdfFile = new File([Buffer.from("%PDF-1.4 fake")], "doc.pdf", { type: "application/pdf" });
    const r = await app.fetch(new Request(`http://localhost/sessions/${SESSION}/upload-image`, {
      method: "POST", body: multipart(pdfFile),
    }));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; path: string };
    expect(body.path.endsWith(".pdf")).toBe(true);
  });

  test("rejects oversize body with 413", async () => {
    // 2-MB body vs 1-MB cap from makeApp()
    const big = new Uint8Array(2 * 1024 * 1024);
    const bigFile = new File([big], "big.png", { type: "image/png" });
    const app = makeApp();
    const r = await app.fetch(new Request(`http://localhost/sessions/${SESSION}/upload-image`, {
      method: "POST", body: multipart(bigFile),
    }));
    expect(r.status).toBe(413);
  });

  test("rejects bad session name grammar with 400", async () => {
    const app = makeApp();
    const r = await app.fetch(new Request(`http://localhost/sessions/Bad.Name/upload-image`, {
      method: "POST", body: multipart(pngFile()),
    }));
    expect(r.status).toBe(400);
  });

  test("rejects missing file part with 400", async () => {
    const app = makeApp();
    const r = await app.fetch(new Request(`http://localhost/sessions/${SESSION}/upload-image`, {
      method: "POST", body: new FormData(),
    }));
    expect(r.status).toBe(400);
  });

  test("rejects upload for non-existent session with 410", async () => {
    const app = makeApp({ sessionExists: () => false });
    const r = await app.fetch(new Request(`http://localhost/sessions/${SESSION}/upload-image`, {
      method: "POST", body: multipart(pngFile()),
    }));
    expect(r.status).toBe(410);
  });

  test("bodyLimit rejects oversize Content-Length before parseBody (413)", async () => {
    const big = new Uint8Array(2 * 1024 * 1024);
    const bigFile = new File([big], "big.png", { type: "image/png" });
    const app = makeApp();
    const r = await app.fetch(new Request(`http://localhost/sessions/${SESSION}/upload-image`, {
      method: "POST", body: multipart(bigFile),
    }));
    expect(r.status).toBe(413);
  });
});
