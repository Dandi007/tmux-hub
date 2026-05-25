import { describe, test, expect } from "bun:test";
import {
  extFromMime,
  extFromFileName,
  imagePathFor,
  todayLocalDate,
} from "../../src/server/image-upload";

describe("extFromMime", () => {
  test("known image mimes → matching ext", () => {
    expect(extFromMime("image/png")).toBe("png");
    expect(extFromMime("image/jpeg")).toBe("jpeg");
    expect(extFromMime("image/gif")).toBe("gif");
    expect(extFromMime("image/webp")).toBe("webp");
    expect(extFromMime("image/heic")).toBe("heic");
    expect(extFromMime("image/heif")).toBe("heif");
  });
  test("non-image mimes → derived ext", () => {
    expect(extFromMime("application/pdf")).toBe("pdf");
    expect(extFromMime("text/plain")).toBe("txt");
    expect(extFromMime("application/zip")).toBe("zip");
    expect(extFromMime("application/json")).toBe("json");
    expect(extFromMime("application/gzip")).toBe("gz");
  });
  test("empty or invalid → null", () => {
    expect(extFromMime("")).toBeNull();
    expect(extFromMime("noslash")).toBeNull();
  });
});

describe("extFromFileName", () => {
  test("extracts extension from filename", () => {
    expect(extFromFileName("report.pdf")).toBe("pdf");
    expect(extFromFileName("photo.PNG")).toBe("png");
    expect(extFromFileName("archive.tar.gz")).toBe("gz");
  });
  test("returns null for no extension", () => {
    expect(extFromFileName("Makefile")).toBeNull();
    expect(extFromFileName(".hidden")).toBeNull();
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
