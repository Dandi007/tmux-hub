import { tmux as defaultTmux } from "./tmux-cmd";
import { getNativeAttachCount } from "./viewport-pinner";
import type { ClientWsMessage } from "../shared/protocol";
import { assertGrammar } from "../shared/session-name";
import { encodeWheel } from "./mouse-encode";
import { createLogger } from "./logger";

const logger = createLogger("input");

// Cap wheel ticks per message so a fast fling can't spawn a huge send-keys
// payload (each tick is one SGR report forwarded to the app).
const WHEEL_MAX_NOTCHES = 20;

export type TmuxRun = (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;

// tmux send-keys -l passes the literal as a single execve argument;
// macOS ARG_MAX and tmux's own parser both impose length limits.
const SEND_KEYS_CHUNK_BYTES = 1024;

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

function classifyTmuxError(session: string, stderr: string): HubError {
  if (/can't find|no such session|no session/i.test(stderr)) {
    return new HubError(`session not found: ${session}`, 410);
  }
  return new HubError(`send-keys failed: ${stderr}`, 500);
}

export class InputRouter {
  private locks = new Map<string, Promise<unknown>>();

  constructor(private run: TmuxRun = defaultTmux) {}

  send(session: string, msg: ClientWsMessage): Promise<{ skipped?: boolean; cols?: number; rows?: number }> {
    // resize-window is independent of pty input and must not queue behind
    // a long-running chunk loop — otherwise xterm.js locally resizes while
    // tmux still outputs at the old size, causing garbled rendering.
    if (msg.kind === "resize") {
      assertGrammar(session);
      return this.doSend(session, msg);
    }
    const prev = this.locks.get(session) ?? Promise.resolve();
    const next = prev.then(() => {
      assertGrammar(session);
      return this.doSend(session, msg);
    });
    this.locks.set(session, next.catch(() => {}));
    return next.then(() => ({}));
  }

  private async doSend(session: string, msg: ClientWsMessage): Promise<{ skipped?: boolean; cols?: number; rows?: number }> {
    if (msg.kind === "keys") {
      const target = `${session}:0.0`;
      const chunks = chunkString(msg.literal, SEND_KEYS_CHUNK_BYTES);
      for (const chunk of chunks) {
        const r = await this.run(["send-keys", "-t", target, "-l", chunk]);
        if (r.code !== 0) {
          logger.error({ session, stderr: r.stderr, chunkLen: chunk.length }, "send-keys (literal) failed");
          throw classifyTmuxError(session, r.stderr);
        }
      }
    } else if (msg.kind === "key") {
      if (!ALLOWED_KEYS.has(msg.name)) {
        logger.warn({ session, key: msg.name }, "unknown key rejected");
        throw new HubError(`unknown key: ${msg.name}`, 400);
      }
      const r = await this.run(["send-keys", "-t", `${session}:0.0`, msg.name]);
      if (r.code !== 0) {
        logger.error({ session, key: msg.name, stderr: r.stderr }, "send-keys (named) failed");
        throw classifyTmuxError(session, r.stderr);
      }
    } else if (msg.kind === "wheel") {
      const notches = Math.min(WHEEL_MAX_NOTCHES, Math.floor(msg.notches));
      if (notches <= 0) return {};
      const col = Math.max(1, Math.floor(msg.col));
      const row = Math.max(1, Math.floor(msg.row));
      const literal = encodeWheel(msg.direction, notches, col, row);
      const r = await this.run(["send-keys", "-t", `${session}:0.0`, "-l", literal]);
      if (r.code !== 0) {
        logger.error({ session, stderr: r.stderr }, "send-keys (wheel) failed");
        throw classifyTmuxError(session, r.stderr);
      }
    } else if (msg.kind === "resize") {
      // Ownership guard: skip resize if native client attached. Thread the
      // injected runner through (adapted to viewport-pinner's throwing style):
      // the default would bypass injection and hit the ambient tmux socket.
      const attachCount = await getNativeAttachCount(session, async (args) => {
        const r = await this.run(args);
        if (r.code !== 0) throw new Error(`tmux ${args.join(" ")} failed (${r.code}): ${r.stderr}`);
        return r.stdout;
      });
      if (attachCount > 0) {
        logger.debug({ session, attachCount }, "native client attached, skipping resize");
        // Query current viewport size to send back
        const sizeOut = await this.run(["display-message", "-p", "-t", `${session}:0`, "#{window_width}|#{window_height}"]);
        if (sizeOut.code === 0) {
          const parts = sizeOut.stdout.split("|").map(Number);
          const cols = parts[0] ?? NaN;
          const rows = parts[1] ?? NaN;
          if (Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) {
            return { skipped: true, cols, rows };
          } else {
            logger.warn({ session, raw: sizeOut.stdout }, "viewport query returned invalid size");
          }
        }
        return { skipped: true };
      }

      const cols = Math.max(20, Math.min(500, Math.floor(msg.cols)));
      const rows = Math.max(5, Math.min(200, Math.floor(msg.rows)));
      const r = await this.run(["resize-window", "-t", `${session}:0`, "-x", String(cols), "-y", String(rows)]);
      if (r.code !== 0) {
        logger.warn({ session, cols, rows, stderr: r.stderr }, "resize-window failed");
      }
      // Report the applied (clamped) size so the caller can keep the emulator
      // grid aligned with the pane.
      return { cols, rows };
    }
    return {};
  }
}

export function chunkString(s: string, maxBytes: number): string[] {
  if (Buffer.byteLength(s) <= maxBytes) return [s];
  const chunks: string[] = [];
  let start = 0;
  while (start < s.length) {
    let end = Math.min(start + maxBytes, s.length);
    while (end > start && Buffer.byteLength(s.slice(start, end)) > maxBytes) {
      end--;
    }
    chunks.push(s.slice(start, end));
    start = end;
  }
  return chunks;
}
