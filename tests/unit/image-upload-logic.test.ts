import { describe, test, expect } from "bun:test";
import {
  IMAGE_MIME_WHITELIST,
  extFromMime,
  imagePathFor,
  todayLocalDate,
} from "../../src/server/image-upload";

describe("IMAGE_MIME_WHITELIST", () => {
  test("contains the 5 expected types", () => {
    expect(new Set(IMAGE_MIME_WHITELIST)).toEqual(
      new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic"]),
    );
  });
});

describe("extFromMime", () => {
  test("known mime → matching ext", () => {
    expect(extFromMime("image/png")).toBe("png");
    expect(extFromMime("image/jpeg")).toBe("jpeg");
    expect(extFromMime("image/gif")).toBe("gif");
    expect(extFromMime("image/webp")).toBe("webp");
    expect(extFromMime("image/heic")).toBe("heic");
  });
  test("unknown mime → null", () => {
    expect(extFromMime("application/pdf")).toBeNull();
    expect(extFromMime("text/plain")).toBeNull();
    expect(extFromMime("")).toBeNull();
  });
});

describe("imagePathFor", () => {
  test("composes {root}/{date}/{uuid}.{ext}", () => {
    const p = imagePathFor("/var/img", "2026-05-23", "abc-123", "png");
    expect(p).toBe("/var/img/2026-05-23/abc-123.png");
  });
  test("never contains ..", () => {
    const p = imagePathFor("/var/img", "2026-05-23", crypto.randomUUID(), "jpeg");
    expect(p).not.toContain("..");
  });
});

describe("todayLocalDate", () => {
  test("returns YYYY-MM-DD format", () => {
    expect(todayLocalDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  test("formats fixed dates with zero-padding", () => {
    expect(todayLocalDate(new Date(2026, 0, 1))).toBe("2026-01-01");
    expect(todayLocalDate(new Date(2026, 11, 31))).toBe("2026-12-31");
    expect(todayLocalDate(new Date(2026, 4, 23))).toBe("2026-05-23");
  });
  test("handles year boundaries with 4-digit padding", () => {
    expect(todayLocalDate(new Date(99, 0, 1))).toMatch(/^\d{4}-01-01$/);
  });
});
