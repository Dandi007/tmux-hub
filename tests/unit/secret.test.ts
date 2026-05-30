import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// We isolate via env override so we don't clobber the real secret files.
const TMP = mkdtempSync("/tmp/tht-secret-");

beforeAll(() => {
  process.env.TMUX_HUB_SECRET_PATH = join(TMP, "hub.secret");
  process.env.TMUX_HUB_ADMIN_SECRET_PATH = join(TMP, "hub.admin.secret");
});

afterAll(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
});

// Re-import after env override so PATH constants pick up our temp paths.
let loadOrCreateSecret: (path?: string) => string;
let safeEqual: (a: string, b: string) => boolean;
let ADMIN_SECRET_PATH: string;
let loadOrCreateAdminSecret: () => string;

describe("secret (loadOrCreateSecret)", () => {
  test("creates secret when file missing", async () => {
    const mod = await import("../../src/server/secret");
    loadOrCreateSecret = mod.loadOrCreateSecret;
    safeEqual = mod.safeEqual;
    ADMIN_SECRET_PATH = mod.ADMIN_SECRET_PATH;
    loadOrCreateAdminSecret = mod.loadOrCreateAdminSecret;

    // File should not exist yet (tmpdir clean)
    const s = loadOrCreateSecret(); // uses TMUX_HUB_SECRET_PATH
    expect(s).toHaveLength(64); // 32 bytes hex
    expect(existsSync(join(TMP, "hub.secret"))).toBe(true);
    expect(readFileSync(join(TMP, "hub.secret"), "utf8").trim()).toBe(s);
  });

  test("re-reads existing secret", () => {
    const s = loadOrCreateSecret();
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

  test("loadOrCreateAdminSecret returns admin secret", () => {
    // Clean admin secret so it gets created fresh
    const adminPath = join(TMP, "hub.admin.secret");
    if (existsSync(adminPath)) rmSync(adminPath);

    const s = loadOrCreateAdminSecret();
    expect(s).toHaveLength(64);
    expect(existsSync(adminPath)).toBe(true);
    // Must be different from hub.secret
    const hubSecret = readFileSync(join(TMP, "hub.secret"), "utf8").trim();
    expect(s).not.toBe(hubSecret);
  });

  test("admin secret path constant is set", () => {
    expect(ADMIN_SECRET_PATH).toBe(join(TMP, "hub.admin.secret"));
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