// Web connections viewing each session, and which of them last pinned the
// pane. tmux keeps one size per window, so a pin by one page leaves every
// other page on the session with a grid that no longer matches; the server
// tells them (see main.ts) and, once the pinning page leaves, lets them reclaim.
export class SessionPeers<T> {
  private readonly bySession = new Map<string, Set<T>>();
  private readonly pinner = new Map<string, T>();

  add(session: string, peer: T): void {
    let set = this.bySession.get(session);
    if (!set) this.bySession.set(session, (set = new Set()));
    set.add(peer);
  }

  /** Returns true if the removed peer was the session's last pinner. */
  remove(session: string, peer: T): boolean {
    const set = this.bySession.get(session);
    set?.delete(peer);
    if (set && set.size === 0) this.bySession.delete(session);
    if (this.pinner.get(session) !== peer) return false;
    this.pinner.delete(session);
    return true;
  }

  pinned(session: string, peer: T): void {
    this.pinner.set(session, peer);
  }

  isPinner(session: string, peer: T): boolean {
    return this.pinner.get(session) === peer;
  }

  others(session: string, peer: T): T[] {
    return [...(this.bySession.get(session) ?? [])].filter((p) => p !== peer);
  }

  size(): number {
    let n = 0;
    for (const s of this.bySession.values()) n += s.size;
    return n;
  }
}
