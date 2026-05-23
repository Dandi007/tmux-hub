import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { isGrammarOk } from "../shared/session-name";

export const IMAGE_MIME_WHITELIST = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
] as const;

export type ImageMime = (typeof IMAGE_MIME_WHITELIST)[number];

const MIME_TO_EXT: Record<ImageMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};

export function extFromMime(mime: string): string | null {
  return (MIME_TO_EXT as Record<string, string>)[mime] ?? null;
}

export function imagePathFor(
  root: string,
  date: string,
  uuid: string,
  ext: string,
): string {
  return `${root}/${date}/${uuid}.${ext}`;
}

// Local-TZ YYYY-MM-DD via explicit zero-padding — does not depend on
// implementation-dependent locale formatting (toLocaleDateString output
// shape can drift across ICU/runtime versions).
export function todayLocalDate(d: Date = new Date()): string {
  const y = d.getFullYear().toString().padStart(4, "0");
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export type ImageUploadDeps = {
  imageDir: string;
  maxBytes: number;
  sessionExists: (name: string) => boolean;
};

export function buildImageUploadRoutes(deps: ImageUploadDeps): Hono {
  const r = new Hono();

  r.post(
    "/sessions/:name/upload-image",
    bodyLimit({
      maxSize: deps.maxBytes,
      onError: (c) => c.json({ error: "file too large" }, 413),
    }),
    async (c) => {
      const name = c.req.param("name");
      if (!isGrammarOk(name)) return c.json({ error: "session name grammar" }, 400);
      if (!deps.sessionExists(name)) return c.json({ error: "session not found" }, 410);

      let parsed: Record<string, string | File>;
      try {
        parsed = (await c.req.parseBody()) as Record<string, string | File>;
      } catch {
        return c.json({ error: "invalid multipart body" }, 400);
      }
      const file = parsed.file;
      if (!(file instanceof File)) {
        return c.json({ error: "missing 'file' part" }, 400);
      }
      if (file.size === 0) {
        return c.json({ error: "empty file" }, 400);
      }
      if (file.size > deps.maxBytes) {
        return c.json({ error: "file too large" }, 413);
      }
      const ext = extFromMime(file.type);
      if (ext === null) {
        return c.json({ error: `unsupported content-type: ${file.type}` }, 400);
      }
      const date = todayLocalDate();
      const uuid = crypto.randomUUID();
      const absPath = imagePathFor(deps.imageDir, date, uuid, ext);
      try {
        await mkdir(dirname(absPath), { recursive: true });
        await Bun.write(absPath, file);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return c.json({ error: `write failed: ${msg}` }, 500);
      }
      return c.json({ ok: true, path: absPath });
    },
  );

  return r;
}
