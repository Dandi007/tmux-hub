import { tmux } from "./tmux-cmd";
import type { SessionInfo, ServerEvent } from "../shared/protocol";
import { REGISTRY_INTERVAL_MS } from "./config";
import { isGrammarOk } from "../shared/session-name";
import type { ManagedSessionDb } from "./managed-db";
import { createLogger } from "./logger";

const logger = createLogger("registry");

const FORMAT = "#{session_name}|#{session_activity}|#{session_attached}|#{session_windows}|#{window_width}|#{window_height}|#{pane_title}";

/**
 * Filter the full tmux session list down to the tmux-hub-managed subset.
 *
 * This is the single source of truth for "which sessions belong to the hub":
 * both the WEB path (SessionRegistry.poll → snapshot) and the TUI path
 * (bin/tmux-hub) call it, so the two surfaces can never drift apart.
 */
export function filterManagedSessions(all: SessionInfo[], managed: Set<string>): SessionInfo[] {
  return all.filter((s) => managed.has(s.name));
}

export function diffSessions(prev: SessionInfo[], next: SessionInfo[]): ServerEvent[] {
  const prevMap = new Map(prev.map((s) => [s.name, s]));
  const nextMap = new Map(next.map((s) => [s.name, s]));
  const events: ServerEvent[] = [];
  for (const [name, info] of nextMap) {
    const p = prevMap.get(name);
    if (!p) {
      events.push({ event: "session_created", payload: info });
    } else if (
      p.activity !== info.activity ||
      p.attached !== info.attached ||
      p.windows !== info.windows ||
      p.cols !== info.cols ||
      p.rows !== info.rows ||
      p.pane_title !== info.pane_title
    ) {
      events.push({ event: "session_activity", payload: info });
    }
  }
  for (const [name] of prevMap) {
    if (!nextMap.has(name)) {
      events.push({ event: "session_removed", payload: { name } });
    }
  }
  return events;
}

/** Injectable tmux runner — production default is the global `tmux`; tests pass a fake. */
export type TmuxRunner = typeof tmux;

export async function listSessions(runner: TmuxRunner = tmux): Promise<SessionInfo[] | null> {
  const r = await runner(["list-sessions", "-F", FORMAT]);
  if (r.code !== 0) {
    // "no sessions": server alive, zero sessions — a genuine empty list.
    if (/no sessions/i.test(r.stderr)) return [];
    // "no server running" (and any other failure) means the probe is
    // inconclusive — NOT "every session is gone". Returning [] here would let
    // poll()'s prune wipe the entire managed_sessions table when the hub is
    // started with a drifted socket/env (historical incident, multiple times).
    return null;
  }
  if (!r.stdout) return [];
  const sessions = r.stdout.split("\n").map((line) => {
    const [name, activity, attached, windows, cols, rows, pane_title] = line.split("|");
    return {
      name: name!,
      activity: Number(activity),
      attached: Number(attached),
      windows: Number(windows),
      cols: Number(cols),
      rows: Number(rows),
      grammar_ok: isGrammarOk(name!),
      pane_title: pane_title || "",
    };
  });
  return Promise.all(sessions.map(enrichCodexTitle));
}

function isCodexSessionName(name: string): boolean {
  return /(^|[-_])codex([-_]|$)/i.test(name);
}

function titleStatusPrefix(title: string): string {
  if (!title) return "";
  const firstChar = title.charAt(0);
  return firstChar === "✳" || /^[\u2800-\u28ff]/.test(firstChar) ? firstChar : "";
}

async function enrichCodexTitle(info: SessionInfo): Promise<SessionInfo> {
  if (!isCodexSessionName(info.name)) return info;
  const promptTitle = await readCodexPromptTitle(info.name);
  if (!promptTitle) return info;
  const prefix = titleStatusPrefix(info.pane_title);
  return {
    ...info,
    pane_title: prefix ? `${prefix} ${promptTitle}` : promptTitle,
  };
}

async function readCodexPromptTitle(name: string): Promise<string> {
  const r = await tmux(["capture-pane", "-p", "-t", `${name}:0.0`, "-S", "-1000"]);
  if (r.code !== 0 || !r.stdout) return "";
  return extractCodexPromptTitle(r.stdout);
}

export function extractCodexPromptTitle(screen: string): string {
  const lines = screen.split("\n");
  let title = "";
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i]!.match(/^›\s*(.+?)\s*$/);
    if (!match) continue;
    const parts = [match[1]!];
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j]!;
      if (!/^  \S/.test(line)) break;
      if (/^(gpt-|o[0-9]|claude|deepseek|qwen|glm)/i.test(line.trim())) break;
      parts.push(line.trim());
    }
    const candidate = parts.join(" ");
    if (isCodexPlaceholderPrompt(candidate)) continue;
    title = candidate;
  }
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
}

function isCodexPlaceholderPrompt(title: string): boolean {
  return title === "Find and fix a bug in @filename" || title === "Implement {feature}";
}

/**
 * A managed session missing from `tmux list-sessions` is only pruned (db row
 * removed + session_removed emitted, which discards its replay log) after
 * this many CONSECUTIVE polls confirm the miss. A single glitched poll —
 * wrong socket, slow tmux, transient error mapped to "no sessions" — must
 * not destroy state (2026-07-10 incident).
 */
export const REMOVAL_CONFIRM_POLLS = 3;

export class SessionRegistry {
  private state: SessionInfo[] = [];
  private serverReachable = true;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(event: ServerEvent) => void>();
  private db: ManagedSessionDb;
  private lister: () => Promise<SessionInfo[] | null>;
  private missingStreak = new Map<string, number>();

  // `lister` is an explicit seam so tests can drive poll() without a live
  // tmux server; production wiring uses the real listSessions.
  constructor(db: ManagedSessionDb, lister: () => Promise<SessionInfo[] | null> = listSessions) {
    this.db = db;
    this.lister = lister;
  }

  async start(): Promise<void> {
    if (this.timer) return;
    await this.poll();
    this.timer = setInterval(() => { void this.poll(); }, REGISTRY_INTERVAL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): SessionInfo[] {
    return this.state;
  }

  isServerReachable(): boolean {
    return this.serverReachable;
  }

  async pollNow(): Promise<void> {
    await this.poll();
  }

  subscribe(fn: (event: ServerEvent) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(event: ServerEvent) {
    for (const fn of this.listeners) fn(event);
  }

  private async poll() {
    const all = await this.lister();
    if (all === null) {
      if (this.serverReachable) {
        this.serverReachable = false;
        logger.error("tmux server unreachable");
        this.emit({ event: "server_down" });
      }
      return;
    }
    if (!this.serverReachable) {
      this.serverReachable = true;
      logger.info("tmux server recovered");
      this.emit({ event: "server_up" });
    }

    const managed = this.db.all();
    const alive = new Set(all.map((s) => s.name));

    // Self-heal: a session we are tracking that is still alive in tmux must
    // not lose management just because its db row vanished out from under us
    // (external writer, stray test, corruption). Dropping it here cascades
    // into session_removed → replay-log discard, so restore the row instead
    // (2026-07-10 incident).
    for (const s of this.state) {
      if (alive.has(s.name) && !managed.has(s.name)) {
        this.db.add(s.name);
        managed.add(s.name);
        logger.warn({ session: s.name }, "managed row vanished while session alive; re-adopted");
      }
    }

    const next = filterManagedSessions(all, managed);

    // Prune DB entries whose tmux sessions no longer exist — debounced: only
    // after REMOVAL_CONFIRM_POLLS consecutive misses. While a removal is
    // pending confirmation, keep the last-known info in `next` so no
    // session_removed (and thus no log discard) fires yet.
    for (const name of managed) {
      if (alive.has(name)) {
        this.missingStreak.delete(name);
        continue;
      }
      const streak = (this.missingStreak.get(name) ?? 0) + 1;
      if (streak >= REMOVAL_CONFIRM_POLLS) {
        this.missingStreak.delete(name);
        this.db.remove(name);
      } else {
        this.missingStreak.set(name, streak);
        const prev = this.state.find((s) => s.name === name);
        if (prev) next.push(prev);
      }
    }
    for (const name of [...this.missingStreak.keys()]) {
      if (!managed.has(name)) this.missingStreak.delete(name);
    }
    const events = diffSessions(this.state, next);
    this.state = next;
    for (const e of events) {
      if (e.event === "session_created") {
        logger.info({ session: e.payload.name }, "session created");
      } else if (e.event === "session_removed") {
        logger.info({ session: (e.payload as { name: string }).name }, "session removed");
      }
      this.emit(e);
    }
  }
}
