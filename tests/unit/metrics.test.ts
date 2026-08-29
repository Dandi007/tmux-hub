import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP = mkdtempSync(join(tmpdir(), "tmux-hub-metrics-"));
const SECRET_PATH = join(TMP, "hub.secret");
const ADMIN_SECRET_PATH = join(TMP, "hub.admin.secret");
const DB_PATH = join(TMP, "managed-sessions.db");
const TEMPLATES_PATH = join(TMP, "templates.yaml");
const SOCKET = join(TMP, "test.sock");

writeFileSync(SECRET_PATH, "metrics-test-secret");
writeFileSync(ADMIN_SECRET_PATH, "metrics-test-admin-secret");
writeFileSync(TEMPLATES_PATH, "templates: []\n");

// Point every prod-state/db/tmux path at temp files BEFORE importing main.ts so
// module-level setup stays process-local and never touches the real tmux server
// or managed-sessions db. The import.meta.main guard keeps Bun.serve dormant.
process.env.TMUX_HUB_SECRET_PATH = SECRET_PATH;
process.env.TMUX_HUB_ADMIN_SECRET_PATH = ADMIN_SECRET_PATH;
process.env.TMUX_HUB_DB_PATH = DB_PATH;
process.env.TMUX_HUB_TEMPLATES_PATH = TEMPLATES_PATH;
process.env.TMUX_HUB_SOCKET = SOCKET;
process.env.TMUX_HUB_PORT = "31520";
process.env.TMUX_HUB_DEV_BIND_SECRET = "0";

// Import AFTER env setup so module-level config reads our temp paths.
const { app } = await import("../../src/server/main");

async function fetchApp(path: string): Promise<Response> {
  return app.request(new Request(`http://localhost${path}`));
}

afterAll(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
});

describe("GET /metrics", () => {
  test("200 text/plain body contains tmux_hub_up 1 (public, no auth header)", async () => {
    const r = await fetchApp("/metrics");
    expect(r.status).toBe(200);
    expect((r.headers.get("content-type") ?? "").startsWith("text/plain")).toBe(true);
    const body = await r.text();
    expect(body).toContain("tmux_hub_up 1");
  });

  test("regression: GET /system/health still reachable", async () => {
    const r = await fetchApp("/system/health");
    expect(r.status).toBe(200);
  });
});
