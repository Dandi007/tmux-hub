// src/server/output-broadcaster.ts
// S1b: pipe-pane redirects to an append-only log file; a polling reader holds a
// byte offset so kill/restart resumes without dropping bytes. See work folder
// for spike S1a/S1b analysis.
import { tmux } from "./tmux-cmd";
import { RingBuffer } from "./ring-buffer";
import { RING_BUFFER_BYTES, REPLAY_CAP_BYTES } from "./config";
import { mkdirSync, openSync, readSync, closeSync, existsSync, unlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createLogger } from "./logger";

const logger = createLogger("broadcaster");

const LOG_DIR = process.env.TMUX_HUB_LOG_DIR
  ? resolve(process.env.TMUX_HUB_LOG_DIR)
  : resolve(homedir(), ".cache/tmux-hub/logs");

type Subscriber = (chunk: Uint8Array) => void;

export type BroadcasterEvent =
  | { kind: "replay_truncated" }
  | { kind: "stopped" }
  | { kind: "error"; message: string };

type EventListener = (event: BroadcasterEvent) => void;

export type TmuxRunner = (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;

export class SessionBroadcaster {
  readonly ring: RingBuffer;
  readonly logPath: string;
  private fd: number | null = null;
  private offset = 0;
  private subscribers = new Set<Subscriber>();
  private eventListeners = new Set<EventListener>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private pollChunk = new Uint8Array(65536);

  constructor(public readonly session: string, private run: TmuxRunner = tmux) {
    this.ring = new RingBuffer(RING_BUFFER_BYTES);
    mkdirSync(LOG_DIR, { recursive: true });
    const safe = session.replace(/[^a-zA-Z0-9_-]/g, "_");
    // Stable per-session log file. Persists across attaches and hub restarts
    // so that history captured while no client is connected is preserved.
    this.logPath = resolve(LOG_DIR, `${safe}.log`);
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error("broadcaster already stopped; create a new instance");
    if (this.fd !== null || this.pollTimer !== null) return;
    // Idempotent: ensure pipe is off, then on. The `-o` flag is a toggle when used
    // without a shell command; we deliberately call it twice (once to turn off any
    // pre-existing pipe, then once to turn ours on with a redirect).
    await this.run(["pipe-pane", "-o", "-t", `${this.session}:0.0`]).catch(() => undefined);
    const shellCmd = `cat >> ${shellQuote(this.logPath)}`;
    const r = await this.run(["pipe-pane", "-t", `${this.session}:0.0`, shellCmd]);
    if (r.code !== 0) {
      logger.error({ session: this.session, code: r.code, stderr: r.stderr }, "pipe-pane failed");
      throw new Error(`pipe-pane failed (${r.code}): ${r.stderr}`);
    }
    if (!existsSync(this.logPath)) {
      // Touch so we can open for read even before tmux writes the first byte.
      closeSync(openSync(this.logPath, "a"));
    }
    this.fd = openSync(this.logPath, "r");
    this.offset = 0;
    this.pollTimer = setInterval(() => { this.poll(); }, 5);
    logger.info({ session: this.session, logPath: this.logPath }, "broadcaster started");
  }

  async sendInitialSnapshot(send: Subscriber): Promise<void> {
    const enc = new TextEncoder();
    send(enc.encode("\x1bc"));
    const r = await this.run(["capture-pane", "-ep", "-t", `${this.session}:0.0`, "-p"]);
    if (r.code === 0 && r.stdout) send(enc.encode(r.stdout));
  }

  attach(send: Subscriber): () => void {
    this.subscribers.add(send);
    return () => { this.subscribers.delete(send); };
  }

  // Replay buffered history (tail of log file up to REPLAY_CAP bytes) then
  // attach for live updates. Bytes that arrive during the replay read are
  // buffered into a tap and flushed AFTER the history so that the subscriber
  // sees a strict 0->now byte order. Subscriber is then attached for live.
  attachWithReplay(send: Subscriber): () => void {
    if (this.fd === null) {
      // Broadcaster hasn't started — fall back to plain attach.
      this.subscribers.add(send);
      return () => { this.subscribers.delete(send); };
    }
    const pending: Uint8Array[] = [];
    const tap = (chunk: Uint8Array): void => { pending.push(chunk); };
    this.subscribers.add(tap);

    const enc = new TextEncoder();
    try {
      const upTo = this.offset;
      const start = Math.max(0, upTo - REPLAY_CAP_BYTES);
      const len = upTo - start;
      // RIS reset clears the terminal state. If we sliced mid-sequence at
      // `start`, xterm may briefly mis-render the first cells; acceptable
      // trade-off vs unbounded replay.
      send(enc.encode("\x1bc"));
      if (len > 0) {
        const buf = new Uint8Array(len);
        readSync(this.fd, buf, 0, len, start);
        send(buf);
      }
    } catch (e) {
      logger.error({ session: this.session, err: e }, "replay read failed");
      for (const l of this.eventListeners) l({ kind: "error", message: `replay: ${String(e)}` });
    } finally {
      this.subscribers.delete(tap);
    }
    // Flush any live bytes that landed during replay, in order.
    for (const chunk of pending) {
      try { send(chunk); } catch { /* swallow per-subscriber */ }
    }
    this.subscribers.add(send);
    return () => { this.subscribers.delete(send); };
  }

  onEvent(fn: EventListener): () => void {
    this.eventListeners.add(fn);
    return () => { this.eventListeners.delete(fn); };
  }

  subscriberCount(): number { return this.subscribers.size; }

  bytesBroadcast(): number { return this.ring.bytesWritten(); }

  async stop(opts: { deleteLog?: boolean } = {}): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    logger.info({ session: this.session, deleteLog: !!opts.deleteLog }, "broadcaster stopping");
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.fd !== null) { try { closeSync(this.fd); } catch { /* ignore */ } this.fd = null; }
    await this.run(["pipe-pane", "-o", "-t", `${this.session}:0.0`]).catch(() => undefined);
    // Default: KEEP the log file so history persists across hub restarts.
    // Only delete when the underlying tmux session is gone (caller passes
    // deleteLog: true from the session_removed handler).
    if (opts.deleteLog) {
      try { if (existsSync(this.logPath)) unlinkSync(this.logPath); } catch { /* ignore */ }
    }
    for (const l of this.eventListeners) l({ kind: "stopped" });
    this.subscribers.clear();
    this.eventListeners.clear();
  }

  private poll(): void {
    if (this.fd === null) return;
    try {
      const st = statSync(this.logPath);
      if (st.size < this.offset) {
        for (const l of this.eventListeners) l({ kind: "replay_truncated" });
        this.offset = st.size;
        return;
      }
      while (true) {
        const n = readSync(this.fd, this.pollChunk, 0, this.pollChunk.length, this.offset);
        if (n <= 0) break;
        this.offset += n;
        const chunk = new Uint8Array(this.pollChunk.subarray(0, n));
        const wasTruncated = this.ring.truncated();
        this.ring.append(chunk);
        if (!wasTruncated && this.ring.truncated()) {
          for (const l of this.eventListeners) l({ kind: "replay_truncated" });
        }
        for (const sub of this.subscribers) {
          try { sub(chunk); } catch { /* swallow subscriber errors */ }
        }
        if (n < this.pollChunk.length) break;
      }
    } catch (e) {
      logger.error({ session: this.session, err: e }, "poll read error");
      for (const l of this.eventListeners) l({ kind: "error", message: String(e) });
    }
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export class BroadcasterRegistry {
  private map = new Map<string, SessionBroadcaster>();

  constructor(private run: TmuxRunner = tmux) {}

  async get(session: string): Promise<SessionBroadcaster> {
    const existing = this.map.get(session);
    if (existing) return existing;
    const b = new SessionBroadcaster(session, this.run);
    this.map.set(session, b);
    await b.start();
    return b;
  }

  has(session: string): boolean { return this.map.has(session); }

  async stop(session: string, opts: { deleteLog?: boolean } = {}): Promise<void> {
    const b = this.map.get(session);
    if (!b) return;
    this.map.delete(session);
    await b.stop(opts);
  }

  async stopAll(): Promise<void> {
    const all = Array.from(this.map.values());
    this.map.clear();
    await Promise.allSettled(all.map((b) => b.stop()));
  }
}
