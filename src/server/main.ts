import { Hono } from "hono";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SessionRegistry } from "./session-registry";
import { SseHub } from "./sse";
import { BroadcasterRegistry, snapshotStats, type SessionBroadcaster } from "./output-broadcaster";
import { InputRouter } from "./input-router";
import { pinViewport, getNativeAttachCount } from "./viewport-pinner";
import { tmux, socketArgs } from "./tmux-cmd";
import { bootstrapTmuxHooks } from "./tmux-bootstrap";
import { loadTemplates, HUB_HOST, HUB_PORT, WINDOW_COLS, WINDOW_ROWS, IMAGE_DIR, MAX_IMAGE_BYTES, expandHome, SUGGEST_ENABLED, SUGGEST_ENDPOINT, SUGGEST_MODEL, SUGGEST_CAPTURE_LINES, SUGGEST_TIMEOUT_MS, SUGGEST_PROTOCOL, SUGGEST_TOKEN, SUGGEST_HISTORY_ENABLED, SUGGEST_HISTORY_PATH, SUGGEST_HISTORY_TOP, VOICE_ENABLED, BLOB_BASE, INTAKE_BASE, UPLOAD_BROKER_ENABLED, UPLOAD_BROKER_BASE, UPLOAD_BROKER_NS, UPLOAD_BROKER_TOKEN } from "./config";
import { buildSuggestRoutes } from "./suggest-routes";
import { buildVoiceRoutes, VOICE_CARD } from "./voice-routes";
import { VoiceStore } from "./voice-store";
import { blobIdToHex } from "./voice/transcribe";
import { fetchIntakeSse } from "./voice/intake-client";
import { makeCcSwitchCaller } from "./suggest/cc-switch-client";
import { loadOrCreateSecret, safeEqual } from "./secret";
import { authGate, adminGate } from "./auth";
import { isGrammarOk, isManagedSessionName } from "../shared/session-name";
import { buildSessionControlRoutes } from "./session-control";
import { buildImageUploadRoutes } from "./image-upload";
import { buildUploadBrokerRoutes } from "./upload-broker";
import { TemplateRunner, TemplateError, launchSession, formatTs14 } from "./template-runner";
import { ManagedSessionDb } from "./managed-db";
import { listSessions } from "./session-registry";
import { createLogger, LOG_FILE } from "./logger";
import { createWsHandlers, clampInt, type WsData } from "./ws-handlers";
import { renderMetrics, openFdCount, type Gauge } from "./metrics";

const logger = createLogger("main");

const SECRET = loadOrCreateSecret();
const templates = loadTemplates();
const templateIds = templates.map((t) => t.id);
const templateRunner = new TemplateRunner(templates);

const managedDb = new ManagedSessionDb();

// retainLog tracks ad-hoc sessions whose logs should survive session exit.
// Default: template sessions delete logs on exit; ad-hoc sessions keep them.
const retainLog = new Set<string>();
for (const n of managedDb.adhocNames()) {
  retainLog.add(n);
}
if (retainLog.size > 0) {
  logger.info({ count: retainLog.size }, "rebuilt retainLog from db");
}

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
    const keepLog = retainLog.has(event.payload.name);
    await broadcasters.stop(event.payload.name, { deleteLog: !keepLog });
    retainLog.delete(event.payload.name);
  }
});

// socket 配置冲突时启动即失败，而不是每次 tmux 调用都抛。
socketArgs();

await registry.start();

try { await bootstrapTmuxHooks(); }
catch (e) { logger.warn({ err: e }, "bootstrap tmux hooks failed"); }

// Auto-create a default session if none are managed
if (registry.snapshot().length === 0 && templates.length > 0) {
  const defaultTemplate = templates.find((t) => t.id === "vault-cc-native") ?? templates[0]!;
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

export const app = new Hono();
app.use("*", authGate);

// Process-local /metrics for loopback Prometheus scraping: public read-only,
// zero dependencies, never touches the tmux registry/session data plane, and
// never 5xxes on data-plane failures — process aliveness is Prometheus `up`.
// Gauges are in-memory reads only (no tmux calls), for leak watching.
const terminalWs = createWsHandlers({ broadcasters, getNativeAttachCount, pinViewport, tmux, sse, managedDb, input, logger });
const METRIC_GAUGES: Gauge[] = [
  { name: "process_resident_memory_bytes", help: "Resident set size in bytes.", value: () => process.memoryUsage().rss },
  { name: "process_heap_used_bytes", help: "JS heap used in bytes.", value: () => process.memoryUsage().heapUsed },
  { name: "process_open_fds", help: "Open file descriptors (Linux only).", value: openFdCount },
  { name: "process_uptime_seconds", help: "Seconds since process start.", value: () => process.uptime() },
  { name: "tmux_hub_sessions", help: "Sessions in the registry snapshot.", value: () => registry.snapshot().length },
  { name: "tmux_hub_ws_connections", help: "Open terminal websockets.", value: () => terminalWs.connections() },
  { name: "tmux_hub_ws_peers", help: "Terminal websockets registered as session peers.", value: () => terminalWs.peers.size() },
  { name: "tmux_hub_sse_clients", help: "Connected SSE clients.", value: () => sse.clientCount() },
  { name: "tmux_hub_broadcasters", help: "Live session broadcasters.", value: () => broadcasters.size() },
  { name: "tmux_hub_broadcaster_subscribers", help: "Data subscribers across all broadcasters.", value: () => broadcasters.subscriberTotal() },
  { name: "tmux_hub_snapshots_total", help: "Attach/resync snapshots delivered.", type: "counter", value: () => snapshotStats.snapshots },
  { name: "tmux_hub_snapshot_retries_total", help: "Extra snapshot captures because bytes were in flight.", type: "counter", value: () => snapshotStats.retries },
  { name: "tmux_hub_snapshot_overlaps_total", help: "Snapshots that never went quiet and were delivered with overlapping bytes.", type: "counter", value: () => snapshotStats.overlaps },
];
app.get("/metrics", (c) => c.text(renderMetrics(METRIC_GAUGES), { headers: { "content-type": "text/plain; charset=utf-8" } }));
// 进程启动时钉住的代码版本：部署后据此核对「在跑的是不是刚部署的 commit」。
// 没有 .git 的部署（sandbox 镜像）由构建时写入 TMUX_HUB_COMMIT。
const COMMIT = (() => {
  const r = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dirname(fileURLToPath(import.meta.url)) });
  return r.exitCode === 0 ? r.stdout.toString().trim() : process.env.TMUX_HUB_COMMIT ?? "unknown";
})();
app.get("/system/health", (c) =>
  c.json({ ok: true, tmux: registry.isServerReachable(), uptime: process.uptime(), commit: COMMIT }),
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
    await launchSession({ name, cwd: expanded, cmd, env });
  } catch (e) {
    if (e instanceof TemplateError) return c.json({ error: e.message }, e.status as 400 | 404 | 409 | 500);
    return c.json({ error: (e as Error).message }, 500);
  }

  managedDb.add(name); // template_id IS NULL → ad-hoc
  retainLog.add(name);
  try { await broadcasters.get(name); } catch (e) {
    logger.error({ session: name, err: e }, "launch broadcaster prime failed");
  }
  await registry.pollNow();
  logger.info({ session: name, cwd: expanded, cmd }, "ad-hoc session launched");
  return c.json({ name }, 201);
});
app.route("/", buildSessionControlRoutes({ broadcasters, managedDb }));
app.route("/", buildImageUploadRoutes({
  imageDir: IMAGE_DIR,
  maxBytes: MAX_IMAGE_BYTES,
  sessionExists: (name) => registry.snapshot().some((s) => s.name === name),
}));
app.route("/", buildUploadBrokerRoutes({
  enabled: UPLOAD_BROKER_ENABLED,
  base: UPLOAD_BROKER_BASE,
  namespace: UPLOAD_BROKER_NS,
  token: UPLOAD_BROKER_TOKEN,
  sessionExists: (name) => registry.snapshot().some((s) => s.name === name),
}));
app.route("/", buildSuggestRoutes({
  enabled: SUGGEST_ENABLED,
  captureLines: SUGGEST_CAPTURE_LINES,
  callModel: makeCcSwitchCaller({
    endpoint: SUGGEST_ENDPOINT,
    model: SUGGEST_MODEL,
    timeoutMs: SUGGEST_TIMEOUT_MS,
    protocol: SUGGEST_PROTOCOL,
    token: SUGGEST_TOKEN,
  }),
  history: {
    enabled: SUGGEST_HISTORY_ENABLED,
    path: SUGGEST_HISTORY_PATH,
    topN: SUGGEST_HISTORY_TOP,
  },
}));
// 语音库：仅在语音启用时开（避免无谓建 db）。按账号保存文本+原始音频引用。
const voiceStore = VOICE_ENABLED ? new VoiceStore() : null;
app.route("/", buildVoiceRoutes({
  enabled: VOICE_ENABLED,
  intake: (bytes) => fetchIntakeSse(bytes, VOICE_CARD, { intakeBase: INTAKE_BASE }),
  store: voiceStore,
  fetchBlob: (blobId) => fetch(`${BLOB_BASE}/blob/${encodeURIComponent(blobIdToHex(blobId))}`),
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

logger.info({
  host: HUB_HOST,
  port: HUB_PORT,
  staticDir: WEB_DIST,
  staticServing: SERVE_STATIC,
  imageDir: IMAGE_DIR,
  logFile: LOG_FILE,
}, "server starting");

// Only bind the HTTP/WS server when run directly (`bun run src/server/main.ts`).
// When imported as a module (tests, other entrypoints) Bun.serve stays dormant —
// module consumers interact with the exported `app` instead.
if (import.meta.main) {
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
      const resyncCapable = url.searchParams.get("resync") === "1";
      const pin = url.searchParams.get("pin") !== "0";
      const data: WsData = { sessionName, cols, rows, connId, unsubs: [], resyncCapable, pin };
      if (server.upgrade(req, { data })) return undefined;
      logger.error({ session: sessionName, connId }, "ws upgrade failed at server.upgrade()");
      return new Response("upgrade failed", { status: 426 });
    }
    return app.fetch(req);
  },
  websocket: terminalWs,
});
}
