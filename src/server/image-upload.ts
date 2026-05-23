export const IMAGE_MIME_WHITELIST = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/heic",
] as const;

export type ImageMime = (typeof IMAGE_MIME_WHITELIST)[number];

const MIME_TO_EXT: Record<ImageMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
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

// Local-TZ YYYY-MM-DD. en-CA happens to format as ISO-8601 date.
export function todayLocalDate(): string {
  return new Date().toLocaleDateString("en-CA");
}
