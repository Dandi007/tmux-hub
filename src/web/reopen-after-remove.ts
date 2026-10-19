// The open session was removed; if it comes straight back under the same name
// (killed and recreated, e.g. the rsi driver rolling its session over), the
// page reopens it instead of leaving the fallback session in view. The intent
// lapses once the user opens another session, or after REOPEN_WINDOW_MS —
// otherwise any much later recreate of that name would steal focus.
export const REOPEN_WINDOW_MS = 30_000;

export class ReopenAfterRemove {
  private name: string | null = null;
  private at = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowMs: number = REOPEN_WINDOW_MS,
  ) {}

  removed(name: string): void {
    this.name = name;
    this.at = this.now();
  }

  cancel(): void {
    this.name = null;
  }

  /** True (once) if `name` is the removed session and the window is still open. */
  take(name: string): boolean {
    if (this.name !== name) return false;
    this.name = null;
    return this.now() - this.at <= this.windowMs;
  }
}
