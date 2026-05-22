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
