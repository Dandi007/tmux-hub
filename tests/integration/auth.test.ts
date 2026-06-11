import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const SECRET_DIR = mkdtempSync("/tmp/tht-auth-");
const SECRET_PATH = join(SECRET_DIR, "hub.secret");
const ADMIN_SECRET_PATH = join(SECRET_DIR, "hub.admin.secret");
const TEST_SECRET = "deadbeef".repeat(8);
writeFileSync(SECRET_PATH, TEST_SECRET);

process.env.TMUX_HUB_SECRET_PATH = SECRET_PATH;
process.env.TMUX_HUB_ADMIN_SECRET_PATH = ADMIN_SECRET_PATH;
process.env.TMUX_HUB_TEMPLATES_PATH = "deploy/templates.yaml.example";
process.env.TMUX_HUB_PORT = "31510";
process.env.TMUX_HUB_DEV_BIND_SECRET = "0";

// Import AFTER env setup so module-level loadOrCreateSecret reads our temp path
const { Hono } = await import("hono");
const { authGate, _resetSecretForTest } = await import("../../src/server/auth");

// Reset cached secret so it re-reads from our test env path
_resetSecretForTest();

function makeApp() {
  const app = new Hono();
  app.use("*", authGate);
  app.get("/system/health", (c) => c.json({ ok: true }));
  app.get("/templates", (c) => c.json([]));
  app.post("/sessions/foo/kill", (c) => c.json({ killed: true }));
  return app;
}

const app = makeApp();

async function fetchApp(path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`http://localhost${path}`, init));
}

afterAll(() => {
  try { rmSync(SECRET_DIR, { recursive: true, force: true }); } catch {}
});

describe("authGate", () => {
  test("PUBLIC: /system/health no header → 200", async () => {
    const r = await fetchApp("/system/health");
    expect(r.status).toBe(200);
  });

  test("READ_ONLY: /templates no header → 200 (anonymous read allowed)", async () => {
    const r = await fetchApp("/templates");
    expect(r.status).toBe(200);
  });

  test("STATE_CHANGE: POST /sessions/foo/kill no header → 401", async () => {
    const r = await fetchApp("/sessions/foo/kill", { method: "POST" });
    expect(r.status).toBe(401);
  });

  test("STATE_CHANGE: POST /sessions/foo/kill wrong secret → 401", async () => {
    const r = await fetchApp("/sessions/foo/kill", {
      method: "POST",
      headers: { "x-hub-secret": "wrong" },
    });
    expect(r.status).toBe(401);
  });

  test("STATE_CHANGE: POST /sessions/foo/kill correct secret → 200", async () => {
    const r = await fetchApp("/sessions/foo/kill", {
      method: "POST",
      headers: { "x-hub-secret": TEST_SECRET },
    });
    expect(r.status).toBe(200);
  });

  test("STATE_CHANGE: secret length mismatch → 401 (safeEqual is constant-time on equal lengths only)", async () => {
    const r = await fetchApp("/sessions/foo/kill", {
      method: "POST",
      headers: { "x-hub-secret": TEST_SECRET + "x" },
    });
    expect(r.status).toBe(401);
  });
});
