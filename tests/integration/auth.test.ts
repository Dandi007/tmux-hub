import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";

const SECRET_DIR = mkdtempSync("/tmp/tht-auth-");
const SECRET_PATH = join(SECRET_DIR, "hub.secret");
const ADMIN_SECRET_PATH = join(SECRET_DIR, "hub.admin.secret");
const TEST_SECRET = "deadbeef".repeat(8);
writeFileSync(SECRET_PATH, TEST_SECRET);

const GATE_KEY = "inject-shared-secret-aaaaaaaaaaaa";

process.env.TMUX_HUB_SECRET_PATH = SECRET_PATH;
process.env.TMUX_HUB_ADMIN_SECRET_PATH = ADMIN_SECRET_PATH;
process.env.TMUX_HUB_TEMPLATES_PATH = "deploy/templates.yaml.example";
process.env.TMUX_HUB_PORT = "31510";
process.env.TMUX_HUB_DEV_BIND_SECRET = "0";
process.env.GATE_INJECT_KEY = GATE_KEY;

// Import AFTER env setup so module-level loadOrCreateSecret reads our temp path
const { Hono } = await import("hono");
const { authGate, _resetSecretForTest } = await import("../../src/server/auth");
const { GATE_APP } = await import("../../src/server/identity");

// Reset cached secret so it re-reads from our test env path
_resetSecretForTest();

// Sign a gate-id identity header pair exactly as gate-auth inject.go does.
function gateSig(uid: string, ts: number, app = GATE_APP, key = GATE_KEY): string {
  return `${ts}.` + createHmac("sha256", key).update(`${uid}|${app}|${ts}`).digest("hex");
}
function gateHeaders(uid: string, ts = Math.floor(Date.now() / 1000), opts: { app?: string; key?: string } = {}) {
  return { "x-auth-user-id": uid, "x-auth-sig": gateSig(uid, ts, opts.app ?? GATE_APP, opts.key ?? GATE_KEY) };
}

function makeApp() {
  const app = new Hono();
  app.use("*", authGate);
  app.get("/system/health", (c) => c.json({ ok: true }));
  app.get("/templates", (c) => c.json([]));
  // "/" is read-only per isReadOnly; echoes resolved identity for assertions.
  app.get("/", (c) => c.json({ id: c.get("identity") ?? null }));
  app.post("/sessions/foo/kill", (c) => c.json({ killed: true, id: c.get("identity") ?? null }));
  return app;
}

const app = makeApp();

async function fetchApp(path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`http://localhost${path}`, init));
}

afterAll(() => {
  try { rmSync(SECRET_DIR, { recursive: true, force: true }); } catch {}
  delete process.env.GATE_INJECT_KEY;
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

describe("authGate · gate-id identity", () => {
  test("WRITE via valid gate headers (no hub.secret) → 200 + identity=uid", async () => {
    const r = await fetchApp("/sessions/foo/kill", { method: "POST", headers: gateHeaders("user-99") });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ killed: true, id: "user-99" });
  });

  test("READ_ONLY with valid gate headers → identity=uid", async () => {
    const r = await fetchApp("/", { headers: gateHeaders("reader-1") });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: "reader-1" });
  });

  test("gate uid takes precedence over hub.secret for identity", async () => {
    const r = await fetchApp("/sessions/foo/kill", {
      method: "POST",
      headers: { ...gateHeaders("gate-user"), "x-hub-secret": TEST_SECRET },
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ id: "gate-user" });
  });

  test("expired gate sig + no secret → 401", async () => {
    const stale = Math.floor(Date.now() / 1000) - 301;
    const r = await fetchApp("/sessions/foo/kill", { method: "POST", headers: gateHeaders("u1", stale) });
    expect(r.status).toBe(401);
  });

  test("wrong-app gate sig (signed for todo) + no secret → 401", async () => {
    const r = await fetchApp("/sessions/foo/kill", {
      method: "POST",
      headers: gateHeaders("u1", Math.floor(Date.now() / 1000), { app: "todo" }),
    });
    expect(r.status).toBe(401);
  });

  test("forged gate sig (wrong key) + no secret → 401", async () => {
    const r = await fetchApp("/sessions/foo/kill", {
      method: "POST",
      headers: gateHeaders("u1", Math.floor(Date.now() / 1000), { key: "attacker-key" }),
    });
    expect(r.status).toBe(401);
  });

  test("read-only with forged gate sig → anonymous (identity=null, read still 200)", async () => {
    const r = await fetchApp("/", {
      headers: gateHeaders("u1", Math.floor(Date.now() / 1000), { key: "attacker-key" }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: null });
  });
});
