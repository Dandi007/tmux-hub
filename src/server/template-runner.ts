import { tmux as defaultTmux } from "./tmux-cmd";
import { expandHome, SESSION_LANG, type Template } from "./config";
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

export async function launchSession(opts: {
  name: string;
  cwd: string;
  cmd: string;
  env?: Record<string, string>;
  tmuxRun?: TmuxRun;
}): Promise<string> {
  const run = opts.tmuxRun ?? defaultTmux;
  const { name, cmd } = opts;

  if (!isGrammarOk(name)) {
    throw new TemplateError(`session name violates grammar: ${name}`, 400);
  }

  const expanded = expandHome(opts.cwd);
  if (!existsSync(expanded)) {
    throw new TemplateError(`cwd does not exist: ${expanded}`, 400);
  }

  // Inject a UTF-8 locale so the launched shell's line editor handles multibyte
  // input (zsh in C locale garbles 中文). Caller-supplied env wins on conflict.
  const localeDefaults: Record<string, string> = SESSION_LANG
    ? { LANG: SESSION_LANG, LC_CTYPE: SESSION_LANG }
    : {};
  const envArgs = buildEnvArgs({ ...localeDefaults, ...opts.env });

  const has = await run(["has-session", "-t", name]);
  if (has.code === 0) throw new TemplateError(`session already exists: ${name}`, 409);

  const r = await run([
    "new-session", "-d", "-s", name, "-c", expanded,
    ...envArgs,
    cmd,
  ]);
  if (r.code !== 0) {
    logger.error({ session: name, stderr: r.stderr }, "new-session failed");
    throw new TemplateError(`new-session failed: ${r.stderr}`, 500);
  }
  logger.info({ session: name, cwd: expanded, envKeys: opts.env ? Object.keys(opts.env) : [] }, "session created");
  return name;
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

    const ts = formatTs14(new Date());
    const name = `${t.id}-${ts}`;

    return launchSession({ name, cwd, cmd: t.cmd, env, tmuxRun: this.tmuxRun });
  }
}

// Build tmux `-e KEY=VAL` flag pairs from an env map; throws on invalid input.
// Keys must match POSIX shell name grammar; values must be non-NUL strings.
export function buildEnvArgs(env?: Record<string, string>): string[] {
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

export function formatTs14(d: Date): string {
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
