import { Hono } from "hono";
import { tmux as defaultTmux } from "./tmux-cmd";
import { CAPTURE_PANE_LINES } from "./config";
import { isGrammarOk } from "../shared/session-name";
import type { BroadcasterRegistry } from "./output-broadcaster";
import type { ManagedSessionDb } from "./managed-db";
import { createLogger } from "./logger";

const logger = createLogger("session-control");

export type TmuxRun = (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;

export type SessionControlDeps = {
  broadcasters: BroadcasterRegistry;
  managedDb?: ManagedSessionDb;
  tmuxRun?: TmuxRun;
};

export function buildSessionControlRoutes(deps: SessionControlDeps): Hono {
  const run: TmuxRun = deps.tmuxRun ?? defaultTmux;
  const r = new Hono();

  r.use("/sessions/:name/*", async (c, next) => {
    const name = c.req.param("name");
    if (!isGrammarOk(name)) return c.json({ error: "session name grammar" }, 400);
    return next();
  });

  r.post("/sessions/:name/kill", async (c) => {
    const name = c.req.param("name");
    if (c.req.header("x-hub-confirm") !== "kill") {
      return c.json({ error: "missing X-Hub-Confirm: kill header" }, 428);
    }
    const result = await run(["kill-session", "-t", name]);
    if (result.code !== 0) {
      logger.warn({ session: name, stderr: result.stderr }, "kill-session failed");
      return c.json({ error: result.stderr }, 410);
    }
    deps.managedDb?.remove(name);
    await deps.broadcasters.stop(name);
    logger.info({ session: name }, "session killed");
    return c.json({ ok: true });
  });

  r.post("/sessions/:name/rename", async (c) => {
    const name = c.req.param("name");
    let body: { to?: string };
    try { body = await c.req.json<{ to: string }>(); }
    catch { return c.json({ error: "invalid json body" }, 400); }
    const to = body.to;
    if (!to || !isGrammarOk(to)) return c.json({ error: "target name grammar" }, 400);
    const result = await run(["rename-session", "-t", name, to]);
    if (result.code !== 0) {
      logger.warn({ session: name, to, stderr: result.stderr }, "rename-session failed");
      return c.json({ error: result.stderr }, 400);
    }
    deps.managedDb?.rename(name, to);
    logger.info({ session: name, to }, "session renamed");
    return c.json({ ok: true, name: to });
  });

  r.post("/sessions/:name/detach", async (c) => {
    const name = c.req.param("name");
    const result = await run(["detach-client", "-s", name]);
    if (result.code !== 0) return c.json({ error: result.stderr }, 400);
    return c.json({ ok: true });
  });

  r.post("/sessions/:name/refresh", async (c) => {
    const name = c.req.param("name");
    const r2 = await run(["capture-pane", "-ep", "-t", `${name}:0.0`, "-S", `-${CAPTURE_PANE_LINES}`, "-p"]);
    if (r2.code !== 0) return c.json({ error: r2.stderr }, 410);
    return c.text(r2.stdout, 200, { "content-type": "text/plain; charset=utf-8" });
  });

  r.post("/system/start-tmux-server", async (c) => {
    logger.info("starting tmux server");
    const result = await run(["start-server"]);
    if (result.code !== 0) {
      logger.error({ stderr: result.stderr }, "start-server failed");
      return c.json({ error: result.stderr }, 500);
    }
    logger.info("tmux server started");
    return c.json({ ok: true });
  });

  return r;
}
