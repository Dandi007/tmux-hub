const KEY = "tmux-hub.last-session";

export function saveLastSession(name: string): void {
  try { localStorage.setItem(KEY, name); } catch {}
}

export function loadLastSession(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}
