import { describe, test, expect, afterEach, afterAll } from "bun:test";
import { Hono } from "hono";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmuxTest, tmuxTestKillServer } from "../helpers/tmux-test";
import { isGrammarOk } from "../../src/shared/session-name";
import { expandHome } from "../../src/server/config";
import { adminGate } from "../../src/server/admin-gate";
import { launchSession, TemplateError, formatTs14 } from "../../src/server/template-runner";
import { ManagedSessionDb } from "../../src/server/managed-db";
import { BroadcasterRegistry } from "../../src/server/output-broadcaster";
import { SessionRegistry } from "../../src/server/session-registry";

const TMP = mkdtempSync("/tmp/tht-launch-");
const ADMIN_SECRET_PATH = join(TMP, "hub.admin.secret");
const ADMIN_SECRET = "deadbeef".repeat(8);
writeFileSync(ADMIN_SECRET_PATH, ADMIN_SECRET);

process.env.TMUX_HUB_ADMIN_SECRET_PATH = ADMIN_SECRET_PATH;
// Keep hub.secret from interfering
const SECRET_PATH = join(TMP, "hub.secret");
writeFileSync(SECRET_PATH, "hub-secret-64-charsXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
process.env.TMUX_HUB_SECRET_PATH = SECRET_PATH;

function uniqSession(prefix: string): string {
  return `user-${prefix}-${Math.floor(Math.random() * 99999999)}`;
}

const testSessions: string[] = [];
const registries: SessionRegistry[] = [];
let dbSeq = 0;

function buildApp() {
  const app = new Hono();
  // Explicit temp path: the bare ManagedSessionDb() form resolves to the real
  // ~/.cache/tmux-hub db, and the polling registry below can prune live rows.
  const managedDb = new ManagedSessionDb(join(TMP, `managed-sessions-${dbSeq++}.db`));
  const retainLog = new Set<string>();
  const registry = new SessionRegistry(managedDb);
  registries.push(registry);
  const broadcasters = new BroadcasterRegistry();

  registry.subscribe(async (event) => {
    if (event.event === "session_removed") {
      const keepLog = retainLog.has(event.payload.name);
      await broadcasters.stop(event.payload.name, { deleteLog: !keepLog });
      retainLog.delete(event.payload.name);
    }
  });
  registry.start().catch(() => {});

  app.post("/sessions", adminGate, async (c) => {
    const body = await c.req
      .json<{ cmd: string; cwd: string; name?: string; env?: Record<string, string> }>()
      .catch(() => null);
    if (!body || typeof body.cmd !== "string" || typeof body.cwd !== "string") {
      return c.json({ error: "body requires cmd (string) and cwd (string)" }, 400);
    }
    const { cmd, cwd, env } = body;
    let name = body.name ?? `adhoc-${formatTs14(new Date())}`;

    if (!isGrammarOk(name)) {
      return c.json({ error: `invalid session name: ${name}` }, 400);
    }
    const expanded = expandHome(cwd);
    if (!existsSync(expanded)) {
      return c.json({ error: `cwd does not exist: ${expanded}` }, 400);
    }

    try {
      await launchSession({ name, cwd: expanded, cmd, env, tmuxRun: tmuxTest });
    } catch (e) {
      if (e instanceof TemplateError) return c.json({ error: e.message }, e.status as 400 | 404 | 409 | 500);
      return c.json({ error: (e as Error).message }, 500);
    }

    managedDb.add(name);
    retainLog.add(name);
    try { await broadcasters.get(name); } catch {}
    await registry.pollNow();
    testSessions.push(name);
    return c.json({ name }, 201);
  });

  return { app, managedDb, retainLog, registry };
}

async function fetchApp(app: Hono, path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`http://localhost${path}`, init));
}

afterEach(async () => {
  for (const n of testSessions) {
    await tmuxTest(["kill-session", "-t", n]).catch(() => {});
  }
  testSessions.length = 0;
});

afterAll(async () => {
  for (const r of registries) r.stop();
  await tmuxTestKillServer();
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
});

describe("POST /sessions (integration)", () => {
  test("creates ad-hoc tmux session and returns 201 {name}", async () => {
    const { app } = buildApp();
    const r = await fetchApp(app, "/sessions", {
      method: "POST",
      headers: { "x-hub-admin-secret": ADMIN_SECRET, "content-type": "application/json" },
      body: JSON.stringify({ cmd: "sleep 30", cwd: "/tmp" }),
    });
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.name).toMatch(/^adhoc-\d{14}$/);
    const list = await tmuxTest(["list-sessions", "-F", "#{session_name}"]);
    expect(list.stdout.split("\n")).toContain(body.name);
  });

  test("uses provided name", async () => {
    const { app } = buildApp();
    const name = uniqSession("launch-named");
    const r = await fetchApp(app, "/sessions", {
      method: "POST",
      headers: { "x-hub-admin-secret": ADMIN_SECRET, "content-type": "application/json" },
      body: JSON.stringify({ cmd: "sleep 30", cwd: "/tmp", name }),
    });
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.name).toBe(name);
    const list = await tmuxTest(["list-sessions", "-F", "#{session_name}"]);
    expect(list.stdout.split("\n")).toContain(name);
  });

  test("propagates env vars to tmux session", async () => {
    const { app } = buildApp();
    const name = uniqSession("launch-env");
    const r = await fetchApp(app, "/sessions", {
      method: "POST",
      headers: { "x-hub-admin-secret": ADMIN_SECRET, "content-type": "application/json" },
      body: JSON.stringify({ cmd: "sleep 30", cwd: "/tmp", name, env: { MY_VAR: "hello" } }),
    });
    expect(r.status).toBe(201);
    const env = await tmuxTest(["show-environment", "-t", name, "MY_VAR"]);
    expect(env.stdout.trim()).toBe("MY_VAR=hello");
  });

  test("401 when admin secret missing", async () => {
    const { app } = buildApp();
    const r = await fetchApp(app, "/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd: "sleep 30", cwd: "/tmp" }),
    });
    expect(r.status).toBe(401);
  });

  test("401 when admin secret is wrong", async () => {
    const { app } = buildApp();
    const r = await fetchApp(app, "/sessions", {
      method: "POST",
      headers: { "x-hub-admin-secret": "wrong", "content-type": "application/json" },
      body: JSON.stringify({ cmd: "sleep 30", cwd: "/tmp" }),
    });
    expect(r.status).toBe(401);
  });

  test("400 when cwd does not exist", async () => {
    const { app } = buildApp();
    const r = await fetchApp(app, "/sessions", {
      method: "POST",
      headers: { "x-hub-admin-secret": ADMIN_SECRET, "content-type": "application/json" },
      body: JSON.stringify({ cmd: "sleep 30", cwd: "/no/such/path" }),
    });
    expect(r.status).toBe(400);
  });

  test("400 when name has bad grammar", async () => {
    const { app } = buildApp();
    const r = await fetchApp(app, "/sessions", {
      method: "POST",
      headers: { "x-hub-admin-secret": ADMIN_SECRET, "content-type": "application/json" },
      body: JSON.stringify({ cmd: "sleep 30", cwd: "/tmp", name: "bad.name!" }),
    });
    expect(r.status).toBe(400);
  });

  test("409 when session with same name already exists", async () => {
    const { app } = buildApp();
    const name = uniqSession("launch-dup");
    const r1 = await fetchApp(app, "/sessions", {
      method: "POST",
      headers: { "x-hub-admin-secret": ADMIN_SECRET, "content-type": "application/json" },
      body: JSON.stringify({ cmd: "sleep 30", cwd: "/tmp", name }),
    });
    expect(r1.status).toBe(201);
    const r2 = await fetchApp(app, "/sessions", {
      method: "POST",
      headers: { "x-hub-admin-secret": ADMIN_SECRET, "content-type": "application/json" },
      body: JSON.stringify({ cmd: "sleep 30", cwd: "/tmp", name }),
    });
    expect(r2.status).toBe(409);
  });

  test("retainLog tracks ad-hoc session after launch", async () => {
    const { app, retainLog } = buildApp();
    const name = uniqSession("launch-retain");
    const r = await fetchApp(app, "/sessions", {
      method: "POST",
      headers: { "x-hub-admin-secret": ADMIN_SECRET, "content-type": "application/json" },
      body: JSON.stringify({ cmd: "sleep 30", cwd: "/tmp", name }),
    });
    expect(r.status).toBe(201);
    // retainLog.add(name) was called inside the handler
    expect(retainLog.has(name)).toBe(true);
  });
});