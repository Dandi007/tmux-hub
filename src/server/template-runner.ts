import { tmux as defaultTmux } from "./tmux-cmd";
import { expandHome, type Template } from "./config";
import { existsSync } from "node:fs";
import { isGrammarOk } from "../shared/session-name";

export type TmuxRun = (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;

export class TemplateError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "TemplateError";
  }
}

export class TemplateRunner {
  constructor(private templates: Template[], private tmuxRun: TmuxRun = defaultTmux) {}

  async run(templateId: string, cwd: string): Promise<string> {
    const t = this.templates.find((x) => x.id === templateId);
    if (!t) throw new TemplateError(`template not found: ${templateId}`, 404);
    if (!t.cwd_choices.includes(cwd)) {
      throw new TemplateError(`cwd '${cwd}' not in cwd_choices for template '${templateId}'`, 400);
    }
    const expanded = expandHome(cwd);
    if (!existsSync(expanded)) throw new TemplateError(`cwd does not exist: ${expanded}`, 400);

    const ts = formatTs14(new Date());
    const name = `${t.id}-${ts}`;
    if (!isGrammarOk(name)) throw new TemplateError(`generated name violates grammar: ${name}`, 500);

    const has = await this.tmuxRun(["has-session", "-t", name]);
    if (has.code === 0) throw new TemplateError(`session already exists: ${name}`, 409);

    const r = await this.tmuxRun(["new-session", "-d", "-s", name, "-c", expanded, t.cmd]);
    if (r.code !== 0) throw new TemplateError(`new-session failed: ${r.stderr}`, 500);
    return name;
  }
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
