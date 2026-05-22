const TEMPLATE_RE = /^[a-z0-9][a-z0-9-]{0,15}-[0-9]{14}$/;
const USER_RE = /^user-[a-z0-9_-]{1,32}$/;

export function isGrammarOk(name: string): boolean {
  return TEMPLATE_RE.test(name) || USER_RE.test(name);
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
