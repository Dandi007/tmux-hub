import { Hono } from "hono";
import { tmux as defaultTmux } from "./tmux-cmd";
import { isGrammarOk } from "../shared/session-name";
import { classifyPaneCommand } from "./suggest/classify";
import { buildSuggestMessages, extractCommand } from "./suggest/prompt";
import { loadHistoryCached, buildHistoryBlock } from "./suggest/history";
import type { ModelCaller } from "./suggest/cc-switch-client";
import { createLogger } from "./logger";

const logger = createLogger("suggest");

export type TmuxRun = (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;

export type SuggestDeps = {
  enabled: boolean;
  captureLines: number;
  callModel: ModelCaller;
  tmuxRun?: TmuxRun;
  history?: { enabled: boolean; path: string; topN: number };
};

async function paneCommand(run: TmuxRun, name: string): Promise<string | null> {
  const r = await run(["display-message", "-p", "-t", `${name}:0.0`, "#{pane_current_command}"]);
  if (r.code !== 0) return null;
  return r.stdout.trim();
}

export function buildSuggestRoutes(deps: SuggestDeps): Hono {
  const run: TmuxRun = deps.tmuxRun ?? defaultTmux;
  const r = new Hono();

  const grammar = async (c: any, next: any) => {
    if (!isGrammarOk(c.req.param("name"))) return c.json({ error: "session name grammar" }, 400);
    return next();
  };
  r.use("/sessions/:name/suggest", grammar);
  r.use("/sessions/:name/pane-mode", grammar);

  r.get("/sessions/:name/pane-mode", async (c) => {
    if (!deps.enabled) return c.json({ mode: "other", enabled: false });
    const cmd = await paneCommand(run, c.req.param("name"));
    if (cmd === null) return c.json({ error: "pane query failed" }, 410);
    return c.json({ mode: classifyPaneCommand(cmd), enabled: true });
  });

  r.post("/sessions/:name/suggest", async (c) => {
    if (!deps.enabled) return c.json({ translated: false }, 200);
    const name = c.req.param("name");
    let body: { text?: string };
    try { body = await c.req.json<{ text: string }>(); }
    catch { return c.json({ error: "invalid json body" }, 400); }
    const text = (body.text ?? "").trim();
    if (text === "") return c.json({ error: "empty text" }, 400);

    const cmd = await paneCommand(run, name);
    if (cmd === null) return c.json({ error: "pane query failed" }, 410);
    if (classifyPaneCommand(cmd) !== "shell") return c.json({ translated: false }, 200);

    const cwdRes = await run(["display-message", "-p", "-t", `${name}:0.0`, "#{pane_current_path}"]);
    const cwd = cwdRes.code === 0 ? cwdRes.stdout.trim() : "";
    const capRes = await run(["capture-pane", "-p", "-t", `${name}:0.0`, "-S", `-${deps.captureLines}`]);
    const recentPane = capRes.code === 0 ? capRes.stdout : "";

    // 构建历史注入块（降级：失败不影响 suggest）
    let historyBlock: string | undefined;
    if (deps.history?.enabled) {
      try {
        const cmds = loadHistoryCached(deps.history.path, deps.history.topN);
        if (cmds !== null && cmds.length > 0) {
          historyBlock = buildHistoryBlock(cmds);
        }
      } catch (e) {
        logger.warn({ err: (e as Error).message }, "history load failed; skipping injection");
      }
    }

    try {
      const raw = await deps.callModel(buildSuggestMessages({ text, cwd, recentPane }, { historyBlock }));
      const command = extractCommand(raw);
      if (command === "") return c.json({ error: "empty suggestion" }, 502);
      return c.json({ translated: true, command });
    } catch (e) {
      logger.warn({ session: name, err: (e as Error).message }, "suggest model call failed");
      return c.json({ error: "model call failed" }, 502);
    }
  });

  return r;
}
