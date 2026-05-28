import { tmux as defaultTmux } from "./tmux-cmd";
import { expandHome, type Template } from "./config";
import { existsSync } from "node:fs";
import { isGrammarOk } from "../shared/session-name";
import { createLogger } from "./logger";

const logger = createLogger("template");

export type TmuxRun = (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;

export class TemplateError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "TemplateError";
  }
}

export class TemplateRunner {
  constructor(private templates: Template[], private tmuxRun: TmuxRun = defaultTmux) {}

  async run(
    templateId: string,
    cwd: string,
    env?: Record<string, string>,
  ): Promise<string> {
    const t = this.templates.find((x) => x.id === templateId);
    if (!t) throw new TemplateError(`template not found: ${templateId}`, 404);
    if (!t.cwd_choices.includes(cwd)) {
      throw new TemplateError(`cwd '${cwd}' not in cwd_choices for template '${templateId}'`, 400);
    }
    const expanded = expandHome(cwd);
    if (!existsSync(expanded)) throw new TemplateError(`cwd does not exist: ${expanded}`, 400);

    const envArgs = buildEnvArgs(env);

    const ts = formatTs14(new Date());
    const name = `${t.id}-${ts}`;
    if (!isGrammarOk(name)) throw new TemplateError(`generated name violates grammar: ${name}`, 500);

    const has = await this.tmuxRun(["has-session", "-t", name]);
    if (has.code === 0) throw new TemplateError(`session already exists: ${name}`, 409);

    const r = await this.tmuxRun([
      "new-session", "-d", "-s", name, "-c", expanded,
      ...envArgs,
      t.cmd,
    ]);
    if (r.code !== 0) {
      logger.error({ template: templateId, session: name, stderr: r.stderr }, "new-session failed");
      throw new TemplateError(`new-session failed: ${r.stderr}`, 500);
    }
    logger.info(
      { template: templateId, session: name, cwd: expanded, envKeys: env ? Object.keys(env) : [] },
      "template session created",
    );
    return name;
  }
}

// Build tmux `-e KEY=VAL` flag pairs from an env map; throws on invalid input.
// Keys must match POSIX shell name grammar; values must be non-NUL strings.
function buildEnvArgs(env?: Record<string, string>): string[] {
  if (!env) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      throw new TemplateError(`invalid env var name: ${JSON.stringify(k)}`, 400);
    }
    if (typeof v !== "string" || v.includes("\0")) {
      throw new TemplateError(`invalid env var value for ${k}`, 400);
    }
    out.push("-e", `${k}=${v}`);
  }
  return out;
}

function formatTs14(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}
