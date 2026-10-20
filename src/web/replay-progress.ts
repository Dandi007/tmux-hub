/** Observe replay completion without confusing an old parse callback with the
 * latest network announcement. A reconnect may abandon any older replay. */
export class ReplayProgress {
  private current = 0;
  private completed = -1;

  get generation(): number { return this.current; }
  get pending(): boolean { return this.completed !== this.current; }
  begin(): void { this.current++; }
  complete(generation: number): void {
    if (generation === this.current) this.completed = generation;
  }
}
