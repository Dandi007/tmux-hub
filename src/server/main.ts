import { Hono } from "hono";
import type { ServerWebSocket } from "bun";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SessionRegistry } from "./session-registry";
import { SseHub } from "./sse";
import { BroadcasterRegistry, type SessionBroadcaster } from "./output-broadcaster";
import { InputRouter, HubError } from "./input-router";
import { pinViewport, getNativeAttachCount } from "./viewport-pinner";
import { tmux } from "./tmux-cmd";
import { bootstrapTmuxHooks } from "./tmux-bootstrap";
import { loadTemplates, HUB_HOST, HUB_PORT, WINDOW_COLS, WINDOW_ROWS, IMAGE_DIR, MAX_IMAGE_BYTES, expandHome, SUGGEST_ENABLED, SUGGEST_ENDPOINT, SUGGEST_MODEL, SUGGEST_CAPTURE_LINES, SUGGEST_TIMEOUT_MS, SUGGEST_PROTOCOL, SUGGEST_HISTORY_ENABLED, SUGGEST_HISTORY_PATH, SUGGEST_HISTORY_TOP, VOICE_ENABLED, BLOB_BASE, ASR_BASE, CLEAN_CC_ENDPOINT, CLEAN_MODEL, CLEAN_TIMEOUT_MS } from "./config";
import { buildSuggestRoutes } from "./suggest-routes";
import { buildVoiceRoutes } from "./voice-routes";
import { VoiceStore } from "./voice-store";
import { transcribeAudio, blobIdToHex } from "./voice/transcribe";
import { cleanViaCcSwitch } from "./voice/clean-client";
import { makeCcSwitchCaller } from "./suggest/cc-switch-client";
import { loadOrCreateSecret, safeEqual } from "./secret";
import { authGate, adminGate } from "./auth";
import { isGrammarOk, isManagedSessionName } from "../shared/session-name";
import { buildSessionControlRoutes } from "./session-control";
import { buildImageUploadRoutes } from "./image-upload";
import { TemplateRunner, TemplateError, launchSession, formatTs14 } from "./template-runner";
import { ManagedSessionDb } from "./managed-db";
import { listSessions } from "./session-registry";
import { createLogger, LOG_FILE } from "./logger";

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
app.route("/", buildSuggestRoutes({
  enabled: SUGGEST_ENABLED,
  captureLines: SUGGEST_CAPTURE_LINES,
  callModel: makeCcSwitchCaller({
    endpoint: SUGGEST_ENDPOINT,
    model: SUGGEST_MODEL,
    timeoutMs: SUGGEST_TIMEOUT_MS,
    protocol: SUGGEST_PROTOCOL,
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
  transcribe: (bytes) => transcribeAudio(bytes, { blobBase: BLOB_BASE, asrBase: ASR_BASE, fetchFn: fetch }),
  clean: (text) => cleanViaCcSwitch(text, { endpoint: CLEAN_CC_ENDPOINT, model: CLEAN_MODEL, timeoutMs: CLEAN_TIMEOUT_MS }),
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

type WsData = {
  sessionName: string;
  cols: number;
  rows: number;
  connId: string;
  unsubs: Array<() => void>;
  // The session's broadcaster, set after attach so resize messages can keep the
  // emulator grid aligned with the pane.
  broadcaster?: SessionBroadcaster;
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

      // Authoritative pane size for the emulator snapshot. Defaults to this
      // client's requested size (web owns → we pin the pane to it below); when a
      // native client owns the pane, it is overwritten with the queried size.
      let paneCols = cols;
      let paneRows = rows;

      // Ownership guard: skip pin if native client attached
      let attachCount = 0;
      try {
        attachCount = await getNativeAttachCount(sessionName);
      } catch (e) {
        logger.warn({ session: sessionName, connId, err: e }, "getNativeAttachCount failed, assuming native attached");
        attachCount = 1; // fail-safe: treat as native attached
      }
      if (attachCount === 0) {
        try { await pinViewport(sessionName, cols, rows); }
        catch (e) {
          logger.warn({ session: sessionName, connId, err: e }, "viewport pin failed");
          try { ws.send(`[hub] viewport pin failed: ${(e as Error).message}\n`); } catch {}
        }
        // R3: send viewport message — web owns
        try { ws.send(JSON.stringify({ kind: "viewport", cols, rows, owner: "web" })); } catch {}
      } else {
        logger.debug({ session: sessionName, attachCount }, "native client attached, skipping viewport pin");
        // R3: send viewport message — native owns, query current size
        try {
          const sizeOut = await tmux(["display-message", "-p", "-t", `${sessionName}:0`, "#{window_width}|#{window_height}"]);
          if (sizeOut.code === 0) {
            const parts = sizeOut.stdout.split("|").map(Number);
            const nc = parts[0] ?? NaN;
            const nr = parts[1] ?? NaN;
            if (Number.isFinite(nc) && Number.isFinite(nr) && nc > 0 && nr > 0) {
              paneCols = nc;
              paneRows = nr;
              try { ws.send(JSON.stringify({ kind: "viewport", cols: nc, rows: nr, owner: "native" })); } catch {}
            } else {
              logger.warn({ session: sessionName, raw: sizeOut.stdout }, "viewport query returned invalid size");
            }
          }
        } catch (e) {
          logger.warn({ session: sessionName, err: e }, "viewport query for native owner failed");
        }
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
      ws.data.broadcaster = b;

      const unsubEvents = b.onEvent((ev) => {
        if (ev.kind === "replay_truncated") {
          sse.emit({ event: "replay_truncated", payload: { name: sessionName } });
        }
      });
      const unsubData = await b.attachWithReplay((chunk) => { try { ws.send(chunk); } catch {} }, paneCols, paneRows);
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
      input.send(sessionName, parsed as Parameters<typeof input.send>[1]).then((result) => {
        // If resize was skipped (native attached), send authoritative viewport back
        if (result?.skipped && result.cols && result.rows) {
          try {
            ws.send(JSON.stringify({ kind: "viewport", cols: result.cols, rows: result.rows, owner: "native" }));
          } catch {}
        } else if (!result?.skipped && result?.cols && result?.rows) {
          // Web resize applied → pane changed size; keep the emulator grid aligned
          // so later snapshots stay coherent at the new width.
          ws.data.broadcaster?.syncEmulatorSize(result.cols, result.rows);
        }
      }).catch((e: unknown) => {
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
