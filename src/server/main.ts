import { Hono } from "hono";
import type { ServerWebSocket } from "bun";
import { SessionRegistry } from "./session-registry";
import { SseHub } from "./sse";
import { BroadcasterRegistry } from "./output-broadcaster";
import { InputRouter, HubError } from "./input-router";
import { pinViewport } from "./viewport-pinner";
import { loadTemplates, HUB_HOST, HUB_PORT, WINDOW_COLS, WINDOW_ROWS } from "./config";
import { loadOrCreateSecret, safeEqual } from "./secret";
import { authGate } from "./auth";
import { isGrammarOk } from "../shared/session-name";
import { buildSessionControlRoutes } from "./session-control";

const SECRET = loadOrCreateSecret();
const registry = new SessionRegistry();
registry.start();

const sse = new SseHub();
const broadcasters = new BroadcasterRegistry();
const input = new InputRouter();

registry.subscribe(async (event) => {
  sse.emit(event);
  if (event.event === "session_removed") {
    await broadcasters.stop(event.payload.name);
  }
});

const templates = loadTemplates();

const app = new Hono();
app.use("*", authGate);

app.get("/system/health", (c) =>
  c.json({ ok: true, tmux: registry.isServerReachable(), uptime: process.uptime() }),
);
app.get("/templates", (c) =>
  c.json(templates.map((t) => ({ id: t.id, name: t.name, cwd_choices: t.cwd_choices }))),
);
app.get("/events", () => sse.attach({ event: "snapshot", payload: registry.snapshot() }));
app.route("/", buildSessionControlRoutes({ broadcasters }));
app.get("/system/auth-check", async (c) => {
  const devBind = process.env.TMUX_HUB_DEV_BIND_SECRET === "1";
  const ident = c.var.identity;
  if (ident && ident !== "local-secret") return c.json({ secret: SECRET, identity: ident });
  if (devBind) return c.json({ secret: SECRET, identity: "dev" });
  return c.json({ error: "unauthorized" }, 401);
});

type WsData = {
  sessionName: string;
  unsubs: Array<() => void>;
};

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
      const data: WsData = { sessionName, unsubs: [] };
      if (server.upgrade(req, { data })) return undefined;
      return new Response("upgrade failed", { status: 426 });
    }
    return app.fetch(req);
  },
  websocket: {
    async open(ws: ServerWebSocket<WsData>) {
      const { sessionName } = ws.data;
      try { await pinViewport(sessionName, WINDOW_COLS, WINDOW_ROWS); }
      catch (e) { try { ws.send(`[hub] viewport pin failed: ${(e as Error).message}\n`); } catch {} }

      const b = await broadcasters.get(sessionName);
      try { await b.sendInitialSnapshot((chunk) => { try { ws.send(chunk); } catch {} }); } catch {}

      if (b.ring.truncated()) sse.emit({ event: "replay_truncated", payload: { name: sessionName } });

      const unsubEvents = b.onEvent((ev) => {
        if (ev.kind === "replay_truncated") {
          sse.emit({ event: "replay_truncated", payload: { name: sessionName } });
        }
      });
      const unsubData = b.attach((chunk) => { try { ws.send(chunk); } catch {} });
      ws.data.unsubs.push(unsubEvents, unsubData);
    },
    async close(ws: ServerWebSocket<WsData>) {
      const { sessionName, unsubs } = ws.data;
      for (const fn of unsubs) try { fn(); } catch {}
      ws.data.unsubs.length = 0;
      const b = broadcasters.has(sessionName) ? await broadcasters.get(sessionName) : null;
      if (b && b.subscriberCount() === 0) {
        await broadcasters.stop(sessionName);
      }
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
