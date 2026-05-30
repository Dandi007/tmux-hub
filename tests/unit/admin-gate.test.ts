import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const TMP = mkdtempSync("/tmp/tht-admin-gate-");
const ADMIN_SECRET_PATH = join(TMP, "hub.admin.secret");
const ADMIN_SECRET = "deadbeef".repeat(8); // 64 chars (32 bytes hex)
writeFileSync(ADMIN_SECRET_PATH, ADMIN_SECRET);

process.env.TMUX_HUB_ADMIN_SECRET_PATH = ADMIN_SECRET_PATH;
process.env.TMUX_HUB_DEV_BIND_SECRET = "0";

// Import AFTER env setup for admin secret path
const { Hono: HonoCls } = await import("hono");
const { adminGate } = await import("../../src/server/admin-gate");

function appWithGate() {
  const app = new HonoCls();
  app.use("/sessions", adminGate);
  app.post("/sessions", (c) => c.json({ name: "test-001" }, 201));
  return app;
}

async function fetchApp(app: Hono, path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`http://localhost${path}`, init));
}

afterAll(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
});

describe("adminGate", () => {
  test("401 when x-hub-admin-secret missing", async () => {
    const app = appWithGate();
    const r = await fetchApp(app, "/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd: "sleep 30", cwd: "/tmp" }),
    });
    expect(r.status).toBe(401);
  });

  test("401 when x-hub-admin-secret is wrong", async () => {
    const app = appWithGate();
    const r = await fetchApp(app, "/sessions", {
      method: "POST",
      headers: { "x-hub-admin-secret": "wrong-secret-value", "content-type": "application/json" },
      body: JSON.stringify({ cmd: "sleep 30", cwd: "/tmp" }),
    });
    expect(r.status).toBe(401);
  });

  test("passes through valid requests with correct secret", async () => {
    const app = appWithGate();
    const r = await fetchApp(app, "/sessions", {
      method: "POST",
      headers: { "x-hub-admin-secret": ADMIN_SECRET, "content-type": "application/json" },
      body: JSON.stringify({ cmd: "sleep 30", cwd: "/tmp" }),
    });
    // 201 or 400 depending on body validation — gate passed if not 401/403
    expect(r.status).not.toBe(401);
    expect(r.status).not.toBe(403);
  });

  test("403 when cf-access-jwt-assertion header present", async () => {
    const app = appWithGate();
    const r = await fetchApp(app, "/sessions", {
      method: "POST",
      headers: {
        "x-hub-admin-secret": ADMIN_SECRET,
        "cf-access-jwt-assertion": "fake-jwt-token-value",
        "content-type": "application/json",
      },
      body: JSON.stringify({ cmd: "sleep 30", cwd: "/tmp" }),
    });
    expect(r.status).toBe(403);
  });

  test("403 when x-forwarded-for header present", async () => {
    const app = appWithGate();
    const r = await fetchApp(app, "/sessions", {
      method: "POST",
      headers: {
        "x-hub-admin-secret": ADMIN_SECRET,
        "x-forwarded-for": "10.0.0.1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ cmd: "sleep 30", cwd: "/tmp" }),
    });
    expect(r.status).toBe(403);
  });

  test("rejects wrong-length secret via safeEqual (constant-time length check)", async () => {
    const app = appWithGate();
    const r = await fetchApp(app, "/sessions", {
      method: "POST",
      headers: { "x-hub-admin-secret": ADMIN_SECRET + "extra", "content-type": "application/json" },
      body: JSON.stringify({ cmd: "sleep 30", cwd: "/tmp" }),
    });
    expect(r.status).toBe(401);
  });
});