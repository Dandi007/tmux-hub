import { tmux } from "./tmux-cmd";
import type { SessionInfo, ServerEvent } from "../shared/protocol";
import { REGISTRY_INTERVAL_MS } from "./config";
import { isGrammarOk } from "../shared/session-name";
import { createLogger } from "./logger";

const logger = createLogger("registry");

const FORMAT = "#{session_name}|#{session_activity}|#{session_attached}|#{session_windows}";

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
      p.windows !== info.windows
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

export async function listSessions(): Promise<SessionInfo[] | null> {
  const r = await tmux(["list-sessions", "-F", FORMAT]);
  if (r.code !== 0) {
    if (/no server running|no sessions/i.test(r.stderr)) return [];
    return null;
  }
  if (!r.stdout) return [];
  return r.stdout.split("\n").map((line) => {
    const [name, activity, attached, windows] = line.split("|");
    return {
      name: name!,
      activity: Number(activity),
      attached: Number(attached),
      windows: Number(windows),
      grammar_ok: isGrammarOk(name!),
    };
  });
}

export class SessionRegistry {
  private state: SessionInfo[] = [];
  private serverReachable = true;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(event: ServerEvent) => void>();

  start() {
    if (this.timer) return;
    void this.poll();
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

  subscribe(fn: (event: ServerEvent) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(event: ServerEvent) {
    for (const fn of this.listeners) fn(event);
  }

  private async poll() {
    const next = await listSessions();
    if (next === null) {
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
