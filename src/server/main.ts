import { Hono } from "hono";
import type { ServerWebSocket } from "bun";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SessionRegistry } from "./session-registry";
import { SseHub } from "./sse";
import { BroadcasterRegistry } from "./output-broadcaster";
import { InputRouter, HubError } from "./input-router";
import { pinViewport } from "./viewport-pinner";
import { bootstrapTmuxHooks } from "./tmux-bootstrap";
import { loadTemplates, HUB_HOST, HUB_PORT, WINDOW_COLS, WINDOW_ROWS, IMAGE_DIR, MAX_IMAGE_BYTES } from "./config";
import { loadOrCreateSecret, safeEqual } from "./secret";
import { authGate } from "./auth";
import { isGrammarOk, isManagedSessionName } from "../shared/session-name";
import { buildSessionControlRoutes } from "./session-control";
import { buildImageUploadRoutes } from "./image-upload";
import { TemplateRunner, TemplateError } from "./template-runner";
import { ManagedSessionDb } from "./managed-db";
import { listSessions } from "./session-registry";
import { createLogger, LOG_FILE } from "./logger";

const logger = createLogger("main");

const SECRET = loadOrCreateSecret();
const templates = loadTemplates();
const templateIds = templates.map((t) => t.id);
const templateRunner = new TemplateRunner(templates);

const managedDb = new ManagedSessionDb();

// Migrate existing tmux sessions that match template patterns into DB
const existing = await listSessions();
if (existing) {
  for (const s of existing) {
    if (isManagedSessionName(s.name, templateIds) && !managedDb.has(s.name)) {
      const tid = templateIds.find((id) => s.name.startsWith(id + "-"));
      managedDb.add(s.name, tid);
      logger.info({ session: s.name }, "migrated existing session to db");
    }
  }
}

const registry = new SessionRegistry(managedDb);
const sse = new SseHub();
const broadcasters = new BroadcasterRegistry();
const input = new InputRouter();

registry.subscribe(async (event) => {
  sse.emit(event);
  if (event.event === "session_created") {
    try { await broadcasters.get(event.payload.name); }
    catch (e) { logger.error({ session: event.payload.name, err: e }, "prime broadcaster failed"); }
  } else if (event.event === "session_removed") {
    await broadcasters.stop(event.payload.name, { deleteLog: true });
  }
});

await registry.start();

try { await bootstrapTmuxHooks(); }
catch (e) { logger.warn({ err: e }, "bootstrap tmux hooks failed"); }

// Auto-create a default session if none are managed
if (registry.snapshot().length === 0 && templates.length > 0) {
  const defaultTemplate = templates.find((t) => t.id === "shell") ?? templates[0]!;
  const cwd = defaultTemplate.cwd_choices[0]!;
  try {
    const name = await templateRunner.run(defaultTemplate.id, cwd);
    managedDb.add(name, defaultTemplate.id);
    await registry.pollNow();
    logger.info({ session: name, template: defaultTemplate.id }, "auto-created default session");
  } catch (e) {
    logger.error({ err: e }, "auto-create default session failed");
  }
}

for (const s of registry.snapshot()) {
  void broadcasters.get(s.name).catch((e) => {
    logger.error({ session: s.name, err: e }, "initial prime failed");
  });
}

const app = new Hono();
app.use("*", authGate);

app.get("/system/health", (c) =>
  c.json({ ok: true, tmux: registry.isServerReachable(), uptime: process.uptime() }),
);
app.get("/templates", (c) =>
  c.json(templates.map((t) => ({ id: t.id, name: t.name, cwd_choices: t.cwd_choices }))),
);
app.post("/templates/:id/run", async (c) => {
  const id = c.req.param("id");
  const body = await c.req
    .json<{ cwd: string; env?: Record<string, string> }>()
    .catch(() => ({ cwd: "", env: undefined }));
  try {
    const name = await templateRunner.run(id, body.cwd, body.env);
    managedDb.add(name, id);
    return c.json({ name }, 201);
  } catch (e) {
    if (e instanceof TemplateError) return c.json({ error: e.message }, e.status as 400 | 404 | 409 | 500);
    return c.json({ error: (e as Error).message }, 500);
  }
});
app.get("/events", () => sse.attach({ event: "snapshot", payload: registry.snapshot() }));
app.route("/", buildSessionControlRoutes({ broadcasters, managedDb }));
app.route("/", buildImageUploadRoutes({
  imageDir: IMAGE_DIR,
  maxBytes: MAX_IMAGE_BYTES,
  sessionExists: (name) => registry.snapshot().some((s) => s.name === name),
}));
app.get("/system/auth-check", async (c) => {
  const devBind = process.env.TMUX_HUB_DEV_BIND_SECRET === "1";
  const ident = c.var.identity;
  if (ident && ident !== "local-secret") return c.json({ secret: SECRET, identity: ident });
  if (devBind) return c.json({ secret: SECRET, identity: "dev" });
  return c.json({ error: "unauthorized" }, 401);
});

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIST = join(HERE, "../../dist/web");
const SERVE_STATIC = existsSync(WEB_DIST);

function staticHeaders(pathname: string): HeadersInit | undefined {
  if (pathname === "/sw.js") {
    return {
      "Service-Worker-Allowed": "/",
      "Cache-Control": "no-cache",
      "Content-Type": "application/javascript; charset=utf-8",
    };
  }
  if (pathname === "/manifest.webmanifest") {
    return {
      "Content-Type": "application/manifest+json; charset=utf-8",
      "Cache-Control": "no-store, must-revalidate",
    };
  }
  if (pathname === "/registerSW.js") {
    return {
      "Cache-Control": "no-cache",
      "Content-Type": "application/javascript; charset=utf-8",
    };
  }
  return undefined;
}

if (SERVE_STATIC) {
  app.get("/*", async (c) => {
    const url = new URL(c.req.url);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(join(WEB_DIST, path));
    const headers = staticHeaders(url.pathname);
    if (await file.exists()) return new Response(file, headers ? { headers } : undefined);
    return new Response(Bun.file(join(WEB_DIST, "index.html")));
  });
}

type WsData = {
  sessionName: string;
  cols: number;
  rows: number;
  connId: string;
  unsubs: Array<() => void>;
};

function clampInt(v: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}

logger.info({
  host: HUB_HOST,
  port: HUB_PORT,
  staticDir: WEB_DIST,
  staticServing: SERVE_STATIC,
  imageDir: IMAGE_DIR,
  logFile: LOG_FILE,
}, "server starting");

Bun.serve({
  hostname: HUB_HOST,
  port: HUB_PORT,
  idleTimeout: 255,
  fetch(req, server) {
    const url = new URL(req.url);
    const wsMatch = url.pathname.match(/^\/ws\/sessions\/([^/]+)$/);
    if (wsMatch) {
      const sessionName = decodeURIComponent(wsMatch[1]!);
      if (!isGrammarOk(sessionName)) {
        logger.warn({ session: sessionName }, "ws upgrade rejected: bad session name");
        return new Response("bad session name", { status: 400 });
      }
      const token = url.searchParams.get("token");
      if (!token || !safeEqual(token, SECRET)) {
        logger.warn({ session: sessionName }, "ws upgrade rejected: auth failed");
        return new Response("unauthorized", { status: 401 });
      }
      if (!registry.snapshot().find((s) => s.name === sessionName)) {
        logger.warn({ session: sessionName }, "ws upgrade rejected: session not found");
        return new Response("session not found", { status: 410 });
      }
      const cols = clampInt(Number(url.searchParams.get("cols")), 20, 500, WINDOW_COLS);
      const rows = clampInt(Number(url.searchParams.get("rows")), 5, 200, WINDOW_ROWS);
      const connId = crypto.randomUUID().slice(0, 8);
      const data: WsData = { sessionName, cols, rows, connId, unsubs: [] };
      if (server.upgrade(req, { data })) return undefined;
      logger.error({ session: sessionName, connId }, "ws upgrade failed at server.upgrade()");
      return new Response("upgrade failed", { status: 426 });
    }
    return app.fetch(req);
  },
  websocket: {
    async open(ws: ServerWebSocket<WsData>) {
      const { sessionName, cols, rows, connId } = ws.data;
      logger.info({ session: sessionName, cols, rows, connId }, "ws open");
      try { await pinViewport(sessionName, cols, rows); }
      catch (e) {
        logger.warn({ session: sessionName, connId, err: e }, "viewport pin failed");
        try { ws.send(`[hub] viewport pin failed: ${(e as Error).message}\n`); } catch {}
      }

      let b: Awaited<ReturnType<typeof broadcasters.get>>;
      try {
        b = await broadcasters.get(sessionName);
      } catch (e) {
        logger.error({ session: sessionName, connId, err: e }, "broadcaster get failed; closing ws");
        try { ws.send(`[hub] broadcaster failed: ${(e as Error).message}\n`); } catch {}
        try { ws.close(1011, "broadcaster failed"); } catch {}
        return;
      }
      if (b.ring.truncated()) sse.emit({ event: "replay_truncated", payload: { name: sessionName } });

      const unsubEvents = b.onEvent((ev) => {
        if (ev.kind === "replay_truncated") {
          sse.emit({ event: "replay_truncated", payload: { name: sessionName } });
        }
      });
      const unsubData = b.attachWithReplay((chunk) => { try { ws.send(chunk); } catch {} });
      ws.data.unsubs.push(unsubEvents, unsubData);
    },
    async close(ws: ServerWebSocket<WsData>, code: number, reason: string) {
      const { sessionName, connId } = ws.data;
      logger.info({ session: sessionName, connId, code, reason: reason || undefined }, "ws close");
      const { unsubs } = ws.data;
      for (const fn of unsubs) try { fn(); } catch {}
      ws.data.unsubs.length = 0;
    },
    message(ws: ServerWebSocket<WsData>, raw) {
      const { sessionName, connId } = ws.data;
      let parsed: unknown;
      try {
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
        parsed = JSON.parse(text);
      } catch {
        logger.debug({ session: sessionName, connId }, "ws message: invalid json");
        try { ws.send(JSON.stringify({ error: "invalid json" })); } catch {}
        return;
      }
      if (typeof parsed === "object" && parsed !== null && (parsed as { kind?: string }).kind === "ping") {
        const ts = (parsed as { ts?: number }).ts ?? 0;
        try { ws.send(JSON.stringify({ kind: "pong", ts })); } catch {}
        return;
      }
      input.send(sessionName, parsed as Parameters<typeof input.send>[1]).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        if (e instanceof HubError && e.code === 410) {
          logger.warn({ session: sessionName, connId }, "input send: session gone");
          try { ws.close(4410, "session gone"); } catch {}
        } else {
          logger.error({ session: sessionName, connId, err: e }, "input send failed");
        }
        try { ws.send(JSON.stringify({ error: msg })); } catch {}
      });
    },
  },
});
