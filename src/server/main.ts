import { Hono } from "hono";
import { SessionRegistry } from "./session-registry";
import { SseHub } from "./sse";
import { loadTemplates, HUB_HOST, HUB_PORT } from "./config";
import { authGate } from "./auth";
import { loadOrCreateSecret } from "./secret";

const registry = new SessionRegistry();
registry.start();

const sse = new SseHub();
registry.subscribe((event) => sse.emit(event));

const templates = loadTemplates();
const SECRET = loadOrCreateSecret();

const app = new Hono();

app.use("*", authGate);

app.get("/system/health", (c) =>
  c.json({ ok: true, tmux: registry.isServerReachable(), uptime: process.uptime() }),
);

app.get("/system/auth-check", async (c) => {
  const devBind = process.env.TMUX_HUB_DEV_BIND_SECRET === "1";
  const ident = c.var.identity;
  if (ident && ident !== "local-secret") {
    return c.json({ secret: SECRET, identity: ident });
  }
  if (devBind) return c.json({ secret: SECRET, identity: "dev" });
  return c.json({ error: "unauthorized" }, 401);
});

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
