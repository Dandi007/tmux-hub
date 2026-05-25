import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { isGrammarOk } from "../shared/session-name";
import { createLogger } from "./logger";

const logger = createLogger("image-upload");

const MIME_EXT_OVERRIDES: Record<string, string> = {
  "image/jpeg": "jpeg",
  "text/plain": "txt",
  "text/html": "html",
  "application/javascript": "js",
  "application/gzip": "gz",
  "application/x-tar": "tar",
  "application/x-bzip2": "bz2",
  "application/x-7z-compressed": "7z",
  "application/x-rar-compressed": "rar",
};

export function extFromMime(mime: string): string | null {
  if (!mime) return null;
  const override = MIME_EXT_OVERRIDES[mime];
  if (override) return override;
  const slash = mime.indexOf("/");
  if (slash < 0) return null;
  const sub = mime.slice(slash + 1).split(";")[0]!.trim().toLowerCase();
  if (sub && /^[a-z0-9]{1,10}$/.test(sub)) return sub;
  return null;
}

export function extFromFileName(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : null;
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
      const ext = extFromFileName(file.name) ?? extFromMime(file.type) ?? "bin";
      const date = todayLocalDate();
      const uuid = crypto.randomUUID();
      const absPath = imagePathFor(deps.imageDir, date, uuid, ext);
      try {
        await mkdir(dirname(absPath), { recursive: true });
        await Bun.write(absPath, file);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.error({ session: name, path: absPath, err: e }, "image write failed");
        return c.json({ error: `write failed: ${msg}` }, 500);
      }
      logger.info({ session: name, path: absPath, size: file.size, mime: file.type }, "image uploaded");
      return c.json({ ok: true, path: absPath });
    },
  );

  return r;
}
