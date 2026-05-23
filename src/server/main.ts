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
import { loadTemplates, HUB_HOST, HUB_PORT, WINDOW_COLS, WINDOW_ROWS, IMAGE_DIR, MAX_IMAGE_BYTES } from "./config";
import { loadOrCreateSecret, safeEqual } from "./secret";
import { authGate } from "./auth";
import { isGrammarOk } from "../shared/session-name";
import { buildSessionControlRoutes } from "./session-control";
import { buildImageUploadRoutes } from "./image-upload";
import { TemplateRunner, TemplateError } from "./template-runner";

const SECRET = loadOrCreateSecret();
const registry = new SessionRegistry();
registry.start();

const sse = new SseHub();
const broadcasters = new BroadcasterRegistry();
const input = new InputRouter();

registry.subscribe(async (event) => {
  sse.emit(event);
  if (event.event === "session_created") {
    // Always-on recording: start the broadcaster as soon as the session is
    // visible to tmux, so output that happens before any WS attach is logged.
    try { await broadcasters.get(event.payload.name); }
    catch (e) { console.error(`[tmux-hub] prime broadcaster failed for ${event.payload.name}:`, e); }
  } else if (event.event === "session_removed") {
    // Session is truly gone from tmux — delete the log file too.
    await broadcasters.stop(event.payload.name, { deleteLog: true });
  }
});

// On startup, prime broadcasters for sessions that already exist. The first
// registry.snapshot() is empty until polling fires; wait a tick.
setTimeout(() => {
  for (const s of registry.snapshot()) {
    void broadcasters.get(s.name).catch((e) => {
      console.error(`[tmux-hub] initial prime failed for ${s.name}:`, e);
    });
  }
}, 100);

const templates = loadTemplates();
const templateRunner = new TemplateRunner(templates);

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
  const body = await c.req.json<{ cwd: string }>().catch(() => ({ cwd: "" }));
  try {
    const name = await templateRunner.run(id, body.cwd);
    return c.json({ name }, 201);
  } catch (e) {
    if (e instanceof TemplateError) return c.json({ error: e.message }, e.status as 400 | 404 | 409 | 500);
    return c.json({ error: (e as Error).message }, 500);
  }
});
app.get("/events", () => sse.attach({ event: "snapshot", payload: registry.snapshot() }));
app.route("/", buildSessionControlRoutes({ broadcasters }));
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

// PWA: explicit headers per resource type. SW must be served with
// `Service-Worker-Allowed: /` so it can claim the entire origin even when
// emitted under a subpath, and `Cache-Control: no-cache` so a stale SW does
// not trap the PWA on an old shell. The manifest needs the
// `application/manifest+json` content-type to be picked up by Lighthouse and
// Edge's install heuristics; `no-store` keeps the install metadata fresh.
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
console.error(`[tmux-hub] static dir ${WEB_DIST} ${SERVE_STATIC ? "(serving)" : "(not built)"}`);
console.error(`[tmux-hub] image dir: ${IMAGE_DIR}`);

type WsData = {
  sessionName: string;
  cols: number;
  rows: number;
  unsubs: Array<() => void>;
};

function clampInt(v: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}

console.error(`[tmux-hub] listening on http://${HUB_HOST}:${HUB_PORT}`);

Bun.serve({
  hostname: HUB_HOST,
  port: HUB_PORT,
  fetch(req, server) {
    const url = new URL(req.url);
    const wsMatch = url.pathname.match(/^\/ws\/sessions\/([^/]+)$/);
    if (wsMatch) {
      const sessionName = decodeURIComponent(wsMatch[1]!);
      if (!isGrammarOk(sessionName)) return new Response("bad session name", { status: 400 });
      const token = url.searchParams.get("token");
      if (!token || !safeEqual(token, SECRET)) return new Response("unauthorized", { status: 401 });
      if (!registry.snapshot().find((s) => s.name === sessionName)) {
        return new Response("session not found", { status: 410 });
      }
      const cols = clampInt(Number(url.searchParams.get("cols")), 20, 500, WINDOW_COLS);
      const rows = clampInt(Number(url.searchParams.get("rows")), 5, 200, WINDOW_ROWS);
      const data: WsData = { sessionName, cols, rows, unsubs: [] };
      if (server.upgrade(req, { data })) return undefined;
      return new Response("upgrade failed", { status: 426 });
    }
    return app.fetch(req);
  },
  websocket: {
    async open(ws: ServerWebSocket<WsData>) {
      const { sessionName, cols, rows } = ws.data;
      // Pin tmux window to client's actual fit() size BEFORE capturing snapshot.
      // Previously hardcoded to WINDOW_COLS/ROWS (200x50), which made xterm wrap
      // wide lines and accumulate scroll-offset (bug 2 root cause).
      try { await pinViewport(sessionName, cols, rows); }
      catch (e) { try { ws.send(`[hub] viewport pin failed: ${(e as Error).message}\n`); } catch {} }

      let b: Awaited<ReturnType<typeof broadcasters.get>>;
      try {
        b = await broadcasters.get(sessionName);
      } catch (e) {
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
      // Replay buffered history (capped at 5 MB tail) then attach for live.
      // Captures output from before this client connected — including time
      // windows when no client was attached at all.
      const unsubData = b.attachWithReplay((chunk) => { try { ws.send(chunk); } catch {} });
      ws.data.unsubs.push(unsubEvents, unsubData);
    },
    async close(ws: ServerWebSocket<WsData>) {
      const { unsubs } = ws.data;
      for (const fn of unsubs) try { fn(); } catch {}
      ws.data.unsubs.length = 0;
      // Do NOT stop the broadcaster when the last client disconnects. We
      // intentionally keep recording so history captured while no one is
      // attached is replayable on next attach. The broadcaster is only
      // stopped when the underlying tmux session is removed (see registry
      // session_removed handler).
    },
    message(ws: ServerWebSocket<WsData>, raw) {
      const { sessionName } = ws.data;
      let parsed: unknown;
      try {
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
        parsed = JSON.parse(text);
      } catch {
        try { ws.send(JSON.stringify({ error: "invalid json" })); } catch {}
        return;
      }
      input.send(sessionName, parsed as Parameters<typeof input.send>[1]).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        try { ws.send(JSON.stringify({ error: msg })); } catch {}
        if (e instanceof HubError && e.code === 410) {
          try { ws.close(4410, "session gone"); } catch {}
        }
      });
    },
  },
});
