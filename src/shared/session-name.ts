const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function isGrammarOk(name: string): boolean {
  return NAME_RE.test(name);
}

export class GrammarError extends Error {
  constructor(public sessionName: string) {
    super(`session name violates grammar: ${sessionName}`);
    this.name = "GrammarError";
  }
}

export function assertGrammar(name: string): void {
  if (!isGrammarOk(name)) throw new GrammarError(name);
}

export function relativeTime(ts: number): string {
  const delta = Math.floor((Date.now() - ts * 1000) / 1000);
  if (delta < 60) return "刚刚";
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  return `${Math.floor(delta / 86400)}d`;
}

export function formatSessionMeta(s: { activity: number; windows: number; attached: number }): string {
  return `${relativeTime(s.activity)} · ${s.windows}w·${s.attached}c`;
}
