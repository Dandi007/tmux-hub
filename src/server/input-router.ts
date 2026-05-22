import { tmux as defaultTmux } from "./tmux-cmd";
import type { ClientWsMessage } from "../shared/protocol";
import { assertGrammar } from "../shared/session-name";

export type TmuxRun = (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;

const ALLOWED_KEYS = new Set([
  "Enter", "Escape", "Tab", "BSpace",
  "Up", "Down", "Left", "Right",
  "Home", "End", "PageUp", "PageDown", "Delete",
  "C-a", "C-b", "C-c", "C-d", "C-e", "C-f", "C-g", "C-h", "C-i", "C-j",
  "C-k", "C-l", "C-m", "C-n", "C-o", "C-p", "C-q", "C-r", "C-s", "C-t",
  "C-u", "C-v", "C-w", "C-x", "C-y", "C-z",
]);

export class HubError extends Error {
  constructor(message: string, public code: number) {
    super(message);
    this.name = "HubError";
  }
}

export class InputRouter {
  private locks = new Map<string, Promise<unknown>>();

  constructor(private run: TmuxRun = defaultTmux) {}

  send(session: string, msg: ClientWsMessage): Promise<void> {
    const prev = this.locks.get(session) ?? Promise.resolve();
    const next = prev.then(() => {
      assertGrammar(session);
      return this.doSend(session, msg);
    });
    this.locks.set(session, next.catch(() => {}));
    return next.then(() => {});
  }

  private async doSend(session: string, msg: ClientWsMessage): Promise<void> {
    const exists = await this.run(["has-session", "-t", session]);
    if (exists.code !== 0) throw new HubError(`session not found: ${session}`, 410);

    if (msg.kind === "keys") {
      const r = await this.run(["send-keys", "-t", `${session}:@0.0`, "-l", msg.literal]);
      if (r.code !== 0) throw new HubError(`send-keys -l failed: ${r.stderr}`, 500);
    } else if (msg.kind === "key") {
      if (!ALLOWED_KEYS.has(msg.name)) {
        throw new HubError(`unknown key: ${msg.name}`, 400);
      }
      const r = await this.run(["send-keys", "-t", `${session}:0.0`, msg.name]);
      if (r.code !== 0) throw new HubError(`send-keys ${msg.name} failed: ${r.stderr}`, 500);
    }
    // kind=resize: no-op (viewport is pinned)
  }
}
