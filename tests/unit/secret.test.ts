import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TMP = mkdtempSync("/tmp/tht-secret-");

// Import fresh — do NOT set global env vars that might conflict with parallel tests
const { loadOrCreateSecret, safeEqual, loadOrCreateAdminSecret } = await import("../../src/server/secret");

describe("secret (loadOrCreateSecret)", () => {
  test("creates secret when file missing", () => {
    const p = join(TMP, "hub.secret");
    const s = loadOrCreateSecret(p);
    expect(s).toHaveLength(64); // 32 bytes hex
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, "utf8").trim()).toBe(s);
  });

  test("re-reads existing secret", () => {
    const p = join(TMP, "hub.secret");
    const s = loadOrCreateSecret(p);
    expect(s).toHaveLength(64);
  });

  test("creates secret at custom path", () => {
    const custom = join(TMP, "custom.secret");
    const s = loadOrCreateSecret(custom);
    expect(s).toHaveLength(64);
    expect(existsSync(custom)).toBe(true);
    expect(readFileSync(custom, "utf8").trim()).toBe(s);
  });

  test("re-reads custom path secret", () => {
    const custom = join(TMP, "custom.secret");
    const s = loadOrCreateSecret(custom);
    expect(s).toHaveLength(64);
  });

  test("loadOrCreateAdminSecret returns admin secret at custom path", () => {
    const adminPath = join(TMP, "hub.admin.secret");
    if (existsSync(adminPath)) rmSync(adminPath);
    const s = loadOrCreateSecret(adminPath);
    expect(s).toHaveLength(64);
    expect(existsSync(adminPath)).toBe(true);
    // Must be different from hub.secret
    const hubSecret = readFileSync(join(TMP, "hub.secret"), "utf8").trim();
    expect(s).not.toBe(hubSecret);
  });

  afterAll(() => {
    try { rmSync(TMP, { recursive: true, force: true }); } catch {}
  });
});

describe("safeEqual", () => {
  test("equal strings return true", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
  });

  test("different strings return false", () => {
    expect(safeEqual("abc", "abd")).toBe(false);
  });

  test("different lengths return false", () => {
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});