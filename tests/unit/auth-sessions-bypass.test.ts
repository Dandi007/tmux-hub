import { describe, test, expect, afterAll } from "bun:test";
import type { Hono } from "hono";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// Regression for the launch-endpoint auth stacking bug: main.ts mounts a global
// `app.use("*", authGate)` AND a route-level `adminGate` on POST /sessions. The
// original admin-gate.test only mounted adminGate, so it never exercised the
// stack — and the global authGate (which requires hub.secret / CF JWT) rejected
// admin-secret-only callers with 401 before adminGate ever ran. This test wires
// BOTH gates exactly like main.ts and asserts an admin-secret-only caller gets
// through to the handler.

const TMP = mkdtempSync("/tmp/tht-auth-stack-");
const HUB_SECRET_PATH = join(TMP, "hub.secret");
const ADMIN_SECRET_PATH = join(TMP, "hub.admin.secret");
const HUB_SECRET = "cafe1234".repeat(8);   // 64 chars
const ADMIN_SECRET = "deadbeef".repeat(8); // 64 chars
writeFileSync(HUB_SECRET_PATH, HUB_SECRET);
writeFileSync(ADMIN_SECRET_PATH, ADMIN_SECRET);

process.env.TMUX_HUB_SECRET_PATH = HUB_SECRET_PATH;
process.env.TMUX_HUB_ADMIN_SECRET_PATH = ADMIN_SECRET_PATH;
process.env.TMUX_HUB_DEV_BIND_SECRET = "0";

const { Hono: HonoCls } = await import("hono");
const { authGate, adminGate } = await import("../../src/server/auth");

// Mirror main.ts wiring: global authGate, then route-level adminGate.
function app(): Hono {
  const a = new HonoCls();
  a.use("*", authGate);
  a.post("/sessions", adminGate, (c) => c.json({ name: "test-001" }, 201));
  // a representative standard control route that must STAY under authGate
  a.post("/sessions/:name/kill", (c) => c.json({ ok: true }));
  return a;
}

function call(path: string, headers: Record<string, string>): Promise<Response> {
  return app().fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ cmd: "sleep 30", cwd: "/tmp" }),
    }),
  );
}

afterAll(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
});

describe("authGate + adminGate stacking on POST /sessions", () => {
  test("admin-secret-only reaches handler (not 401 from authGate)", async () => {
    const r = await call("/sessions", { "x-hub-admin-secret": ADMIN_SECRET });
    expect(r.status).toBe(201); // would be 401 before the authGate bypass fix
  });

  test("no credentials → 401 (adminGate rejects, authGate bypassed)", async () => {
    const r = await call("/sessions", {});
    expect(r.status).toBe(401);
  });

  test("tunnel header still rejected by adminGate even with admin secret", async () => {
    const r = await call("/sessions", {
      "x-hub-admin-secret": ADMIN_SECRET,
      "cf-access-jwt-assertion": "fake-jwt",
    });
    expect(r.status).toBe(403);
  });

  test("hub.secret alone does NOT satisfy the launch endpoint (adminGate still gates)", async () => {
    const r = await call("/sessions", { "x-hub-secret": HUB_SECRET });
    expect(r.status).toBe(401); // passes authGate but adminGate needs admin secret
  });

  test("bypass is scoped: /sessions/:name/kill still gated by authGate", async () => {
    const r = await call("/sessions/foo/kill", {}); // no creds
    expect(r.status).toBe(401); // authGate rejects (bypass must not leak to control routes)
  });

  test("standard control route passes authGate with hub.secret", async () => {
    const r = await call("/sessions/foo/kill", { "x-hub-secret": HUB_SECRET });
    expect(r.status).toBe(200);
  });
});
