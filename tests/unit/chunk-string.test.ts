import { describe, test, expect } from "bun:test";
import { chunkString } from "../../src/server/input-router";

describe("chunkString", () => {
  test("returns single chunk when within limit", () => {
    expect(chunkString("hello", 1024)).toEqual(["hello"]);
  });

  test("returns single chunk for empty string", () => {
    expect(chunkString("", 1024)).toEqual([""]);
  });

  test("splits ASCII evenly", () => {
    const s = "a".repeat(3000);
    const chunks = chunkString(s, 1024);
    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBe(1024);
    expect(chunks[1].length).toBe(1024);
    expect(chunks[2].length).toBe(952);
    expect(chunks.join("")).toBe(s);
  });

  test("does not split multi-byte characters", () => {
    // each CJK char is 3 bytes in UTF-8
    const s = "你".repeat(400); // 1200 bytes
    const chunks = chunkString(s, 1024);
    expect(chunks.length).toBe(2);
    for (const c of chunks) {
      expect(Buffer.byteLength(c)).toBeLessThanOrEqual(1024);
    }
    expect(chunks.join("")).toBe(s);
  });

  test("handles 4-byte emoji", () => {
    // 🚀 is 4 bytes
    const s = "🚀".repeat(300); // 1200 bytes
    const chunks = chunkString(s, 1024);
    expect(chunks.length).toBe(2);
    for (const c of chunks) {
      expect(Buffer.byteLength(c)).toBeLessThanOrEqual(1024);
    }
    expect(chunks.join("")).toBe(s);
  });

  test("every chunk respects byte limit", () => {
    const s = "abc你好🚀xyz".repeat(200);
    const chunks = chunkString(s, 512);
    for (const c of chunks) {
      expect(Buffer.byteLength(c)).toBeLessThanOrEqual(512);
    }
    expect(chunks.join("")).toBe(s);
  });
});
