import { Hono } from "hono";
import { SessionRegistry } from "./session-registry";
import { SseHub } from "./sse";
import { loadTemplates, HUB_HOST, HUB_PORT } from "./config";

const registry = new SessionRegistry();
registry.start();

const sse = new SseHub();
registry.subscribe((event) => sse.emit(event));

const templates = loadTemplates();

const app = new Hono();

app.get("/system/health", (c) =>
  c.json({ ok: true, tmux: registry.isServerReachable(), uptime: process.uptime() }),
);

app.get("/templates", (c) =>
  c.json(templates.map((t) => ({ id: t.id, name: t.name, cwd_choices: t.cwd_choices }))),
);

app.get("/events", () => sse.attach({ event: "snapshot", payload: registry.snapshot() }));

console.error(`[tmux-hub] listening on http://${HUB_HOST}:${HUB_PORT}`);

Bun.serve({
  hostname: HUB_HOST,
  port: HUB_PORT,
  fetch: app.fetch,
});
