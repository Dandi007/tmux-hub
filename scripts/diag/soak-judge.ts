// Pure helpers for scripts/diag/soak.ts: parse /metrics and decide whether the
// connection lifecycle leaked after every browser has gone away.

export type Metrics = Record<string, number>;

export function parseMetrics(text: string): Metrics {
  const out: Metrics = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([a-zA-Z_:][\w:]*) (\S+)$/);
    if (m) out[m[1]!] = Number(m[2]);
  }
  return out;
}

// fd count wobbles by a couple (timers, log rotation, the /proc read itself).
const FD_SLACK = 2;
const RETURN_TO_ZERO = ["tmux_hub_ws_connections", "tmux_hub_sse_clients", "tmux_hub_broadcaster_subscribers"];

export function judgeSoak(base: Metrics, end: Metrics): string[] {
  const problems: string[] = [];
  for (const k of RETURN_TO_ZERO) {
    if (end[k] === undefined) problems.push(`${k} missing from /metrics`);
    else if (end[k] !== (base[k] ?? 0)) problems.push(`${k}: ${base[k] ?? 0} -> ${end[k]} (should return to baseline)`);
  }
  const fd0 = base.process_open_fds, fd1 = end.process_open_fds;
  if (fd0 !== undefined && fd1 !== undefined && fd1 > fd0 + FD_SLACK) {
    problems.push(`process_open_fds: ${fd0} -> ${fd1} (> ${FD_SLACK} above baseline)`);
  }
  if (end.tmux_hub_broadcasters !== undefined && end.tmux_hub_sessions !== undefined
      && end.tmux_hub_broadcasters !== end.tmux_hub_sessions) {
    problems.push(`tmux_hub_broadcasters ${end.tmux_hub_broadcasters} != tmux_hub_sessions ${end.tmux_hub_sessions}`);
  }
  return problems;
}

// Rows that differ between the browser's xterm screen and `capture-pane -p`,
// ignoring trailing blanks and blank tail rows (capture-pane trims them).
export function screenDiff(xterm: string[], tmux: string[]): number {
  const norm = (ls: string[]) => {
    const o = ls.map((l) => l.replace(/\s+$/, ""));
    while (o.length && o.at(-1) === "") o.pop();
    return o;
  };
  const a = norm(xterm), b = norm(tmux);
  let n = 0;
  for (let k = 0; k < Math.max(a.length, b.length); k++) if (a[k] !== b[k]) n++;
  return n;
}
