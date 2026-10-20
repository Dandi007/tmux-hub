// src/server/output-broadcaster.ts
// S1b: pipe-pane redirects to an append-only log file; a polling reader holds a
// byte offset so kill/restart resumes without dropping bytes. See work folder
// for spike S1a/S1b analysis.
import { tmux } from "./tmux-cmd";
import {
  REPLAY_CAP_BYTES,
  EMULATOR_ENABLED,
  PIPE_SINK_CMD,
  SNAPSHOT_SCROLLBACK_LINES,
  WINDOW_COLS,
  WINDOW_ROWS,
} from "./config";
import { SessionEmulator } from "./session-emulator";
import { TitleSeqFilter } from "./title-seq-filter";
import { mkdirSync, openSync, readSync, closeSync, existsSync, unlinkSync, statSync, fstatSync, renameSync, readdirSync, constants as fsc } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { createLogger } from "./logger";

const logger = createLogger("broadcaster");

const LOG_DIR = process.env.TMUX_HUB_LOG_DIR
  ? resolve(process.env.TMUX_HUB_LOG_DIR)
  : resolve(homedir(), ".cache/tmux-hub/logs");

// Discarded replay logs are moved here instead of unlinked, so a false
// session_removed (glitched poll, external db wipe — 2026-07-10 incident)
// never destroys history irrecoverably. Entries older than the retention
// window are pruned opportunistically on each discard.
const TRASH_DIR = resolve(LOG_DIR, ".trash");
const TRASH_RETAIN_MS = 7 * 24 * 60 * 60 * 1000;

// How much of an existing log's end start() feeds the title filter (output
// discarded) so a window-name sequence cut at EOF is still stripped. Twice the
// filter's name cap, so the sequence's opening `ESC k` is always inside.
const TITLE_PRIME_BYTES = 2048;

// The pane log is written by tmux's sink as the pane's user. In hub-sandbox
// that user is the untrusted agent, which can replace the file with a link to a
// hub-private file; reading through it would stream that file to viewers
// (issue #150). Open without following a final symlink and accept only a
// regular file with a single name. A missing log is created the same way.
function openLogForRead(logPath: string): number {
  const fd = openSync(logPath, fsc.O_RDONLY | fsc.O_CREAT | fsc.O_NOFOLLOW, 0o666);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) {
      throw new Error(`refusing pane log ${logPath}: not a regular single-link file`);
    }
    return fd;
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}

function trashLog(logPath: string): void {
  mkdirSync(TRASH_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  renameSync(logPath, resolve(TRASH_DIR, `${basename(logPath, ".log")}.${stamp}.log`));
  for (const f of readdirSync(TRASH_DIR)) {
    const p = resolve(TRASH_DIR, f);
    try { if (Date.now() - statSync(p).mtimeMs > TRASH_RETAIN_MS) unlinkSync(p); } catch { /* ignore */ }
  }
}

type Subscriber = (chunk: Uint8Array) => void;

// Attach snapshot alignment (see attachWithReplay): how long after a capture
// the pipe-pane → log → poll path must stay silent for the capture to count,
// and how many captures to try before tolerating the overlap. The path's lag
// is one 5ms poll tick plus the sink's write, so 30ms leaves ample margin.
const ALIGN_SETTLE_MS = 30;
const ALIGN_MAX_CAPTURES = 5;

// Process-wide attach/resync snapshot counters for /metrics. `retries` are
// extra captures because bytes were in flight; `overlaps` are snapshots that
// never went quiet and were delivered with the overlap tolerated — the case
// that can still leave a client misaligned.
export const snapshotStats = { snapshots: 0, retries: 0, overlaps: 0 };

export type BroadcasterEvent =
  | { kind: "replay_truncated" }
  | { kind: "stopped" }
  | { kind: "error"; message: string };

type EventListener = (event: BroadcasterEvent) => void;

export type TmuxRunner = (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;

export class SessionBroadcaster {
  private broadcastBytes = 0;
  private lastOutputAt = 0;
  readonly logPath: string;
  private fd: number | null = null;
  private offset = 0;
  private emulator: SessionEmulator | null = null;
  private subscribers = new Set<Subscriber>();
  private eventListeners = new Set<EventListener>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private pollChunk = new Uint8Array(65536);
  // Live bytes go through this before anyone sees them (xterm.js would print
  // screen's window-name sequence; see title-seq-filter.ts). The log keeps raw.
  private titleFilter = new TitleSeqFilter();

  // emulatorEnabled defaults to the module-level config flag (production wiring);
  // it is an explicit constructor seam only so tests can pin the path
  // deterministically without depending on cross-file env/module-cache ordering.
  constructor(
    public readonly session: string,
    private run: TmuxRunner = tmux,
    private readonly emulatorEnabled: boolean = EMULATOR_ENABLED,
  ) {
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
    // PIPE_SINK_CMD must flush per read (not line-buffer); see config.ts. A
    // line-buffered sink (uutils cat) batches Claude's newline-sparse redraws
    // into ~1.7s lumps, making the browser clock jump every few seconds.
    const shellCmd = `${PIPE_SINK_CMD} >> ${shellQuote(this.logPath)}`;
    const r = await this.run(["pipe-pane", "-t", `${this.session}:0.0`, shellCmd]);
    if (this.stopped) {
      // stop() ran while we awaited tmux; its pipe close may have landed before
      // our open. Close again and leave without opening the fd or the timer —
      // nothing would ever release them.
      if (r.code === 0) await this.run(["pipe-pane", "-o", "-t", `${this.session}:0.0`]).catch(() => undefined);
      throw new Error("broadcaster stopped during start");
    }
    if (r.code !== 0) {
      logger.error({ session: this.session, code: r.code, stderr: r.stderr }, "pipe-pane failed");
      throw new Error(`pipe-pane failed (${r.code}): ${r.stderr}`);
    }
    try {
      // Created if missing so we can read before tmux writes the first byte.
      this.fd = openLogForRead(this.logPath);
      // Live bytes start at the current end: nothing reads the history through
      // poll (the emulator primes and legacy replay read the fd directly), and
      // re-reading a long-lived session's log blocked the event loop ~12ms/MB on
      // every hub restart.
      this.offset = fstatSync(this.fd).size;
      if (this.offset > 0) {
        const len = Math.min(this.offset, TITLE_PRIME_BYTES);
        const tail = new Uint8Array(len);
        const n = readSync(this.fd, tail, 0, len, this.offset - len);
        this.titleFilter.push(tail.subarray(0, n));
      }
    } catch (e) {
      // Nobody holds a failed instance (the registry drops it), so release the
      // fd and the pipe opened above here or they outlive it.
      if (this.fd !== null) { try { closeSync(this.fd); } catch { /* ignore */ } }
      this.fd = null;
      await this.run(["pipe-pane", "-o", "-t", `${this.session}:0.0`]).catch(() => undefined);
      throw e;
    }
    this.pollTimer = setInterval(() => { this.poll(); }, 5);
    logger.info({ session: this.session, logPath: this.logPath }, "broadcaster started");
  }

  // Lazily build the emulator on first attach, sized to the ACTUAL pane width.
  // The pipe-pane byte stream is width-specific — it was rendered by the app for
  // the current pane size — so the emulator MUST match that width or every wide
  // rule wraps and every absolute cursor move clamps, corrupting the snapshot.
  // Prime it from the current log tail so the snapshot reflects existing
  // history; xterm keeps only the last `scrollback` lines. A later attach may
  // re-pin the pane to a new size, so an existing emulator is resized to track
  // it. (Mid-stream reflow of already-captured history lands in P1.)
  private ensureEmulator(cols: number, rows: number): SessionEmulator {
    if (this.emulator) {
      this.emulator.resize(cols, rows);
      return this.emulator;
    }
    const e = new SessionEmulator(cols, rows, SNAPSHOT_SCROLLBACK_LINES);
    if (this.fd !== null && this.offset > 0) {
      const cap = REPLAY_CAP_BYTES;
      const start = Math.max(0, this.offset - cap);
      const len = this.offset - start;
      if (len > 0) {
        const buf = new Uint8Array(len);
        try {
          readSync(this.fd, buf, 0, len, start);
          // Starting at a line boundary avoids mid-line corruption. A residual
          // mid-escape-sequence risk across the newline is rare and the visible
          // screen (end of stream) is always correct; a fully clean rebuild from
          // byte 0 is a possible P1 refinement.
          if (start > 0) {
            const nlIdx = buf.indexOf(0x0a);
            e.write(nlIdx !== -1 ? buf.subarray(nlIdx + 1) : buf);
          } else {
            e.write(buf);
          }
        } catch (err) {
          logger.warn({ session: this.session, err }, "emulator prime read failed");
        }
      }
    }
    this.emulator = e;
    return e;
  }

  attach(send: Subscriber): () => void {
    this.subscribers.add(send);
    return () => { this.subscribers.delete(send); };
  }

  // Authoritative restore stream for the visible screen + scrollback, sourced
  // from `tmux capture-pane` rather than replaying the width-frozen pipe-pane
  // log. Replaying history authored at a different width corrupts a
  // non-alt-screen TUI (wide rules wrap and overlay text, in-place redraw
  // frames stack). capture-pane gives tmux's own grid at the live pane size the
  // client was just pinned to. The visible screen is captured row for row (no
  // `-J`): tmux 3.6 does not re-join rows that wrapped at a narrower width when
  // the window is widened, so joining them would hand the client fewer rows
  // than tmux shows and shift the whole screen (phone-width sessions). History
  // keeps `-J` so the client re-wraps scrollback to its own width. `-e` keeps
  // SGR colors. DEC private modes are not captured by tmux, so we append the
  // emulator's shadow-tracked modes. Falls back to the emulator serialize if
  // capture fails.
  //
  // History and the visible screen are captured and placed separately. One
  // capture of both cannot be laid out reliably: the runner trims trailing
  // blank rows, so a mostly blank screen came back short, nothing scrolled the
  // history off and it was drawn ON the screen (a fresh zsh after a resize
  // showed its PROMPT_SP line and old prompts above the live prompt). Instead:
  // history lines, then enough LFs to push all of it into scrollback, then
  // home and the visible rows, then modes and an absolute CUP to tmux's cursor
  // (after the capture the client cursor is anywhere, and a replayed DECSTBM
  // homes it; live output with relative moves would land on the wrong row).
  // Geometry is read first, inside attachWithReplay's alignment window, so all
  // of it describes the same instant.
  private async captureSnapshot(cols: number, rows: number): Promise<string> {
    const emu = this.ensureEmulator(cols, rows); // keep shadow primed + live-fed for modes
    const target = `${this.session}:0.0`;
    try {
      const geo = await this.paneGeometry();
      const vis = await this.run(["capture-pane", "-e", "-p", "-t", target]);
      if (vis.code === 0) {
        let out = "\x1bc";
        const hist = geo ? Math.min(geo.history, SNAPSHOT_SCROLLBACK_LINES) : 0;
        if (geo && hist > 0) {
          const h = await this.run(["capture-pane", "-e", "-p", "-J", "-t", target, "-S", `-${hist}`, "-E", "-1"]);
          if (h.code === 0 && h.stdout !== "") {
            out += toCrlf(h.stdout) + "\r\n" + "\n".repeat(Math.max(0, geo.height - 1)) + "\x1b[H";
          }
        }
        out += toCrlf(vis.stdout) + emu.serializeModes();
        if (geo) out += `\x1b[${geo.cursorY + 1};${geo.cursorX + 1}H`;
        return out;
      }
      logger.warn(
        { session: this.session, code: vis.code, stderr: vis.stderr },
        "capture-pane failed; falling back to emulator snapshot",
      );
    } catch (e) {
      logger.warn({ session: this.session, err: e }, "capture-pane threw; falling back to emulator snapshot");
    }
    return emu.snapshot();
  }

  private async paneGeometry(): Promise<{ cursorX: number; cursorY: number; history: number; height: number } | null> {
    try {
      const r = await this.run([
        "display-message", "-p", "-t", `${this.session}:0.0`,
        "#{cursor_x} #{cursor_y} #{history_size} #{pane_height}",
      ]);
      const m = /^(\d+) (\d+) (\d+) (\d+)/.exec(r.stdout.trim());
      if (r.code === 0 && m) {
        return { cursorX: Number(m[1]), cursorY: Number(m[2]), history: Number(m[3]), height: Number(m[4]) };
      }
    } catch { /* fall through: no history, no cursor restore */ }
    return null;
  }

  // Replay buffered history (tail of log file up to REPLAY_CAP bytes) then
  // attach for live updates. Bytes that arrive during the replay read are
  // buffered into a tap and flushed AFTER the history so that the subscriber
  // sees a strict 0->now byte order. Subscriber is then attached for live.
  // `paneCols`/`paneRows` are the authoritative pane size the caller just pinned
  // the tmux window to (or the native owner's size). The emulator is built/kept
  // at that size; invalid/omitted values fall back to the WINDOW_* defaults.
  async attachWithReplay(send: Subscriber, paneCols?: number, paneRows?: number, onOverlap?: () => void): Promise<() => void> {
    if (this.fd === null) {
      // Broadcaster hasn't started — fall back to plain attach.
      this.subscribers.add(send);
      return () => { this.subscribers.delete(send); };
    }
    let pending: Uint8Array[] = [];
    const tap = (chunk: Uint8Array): void => { pending.push(chunk); };
    // Register the tap BEFORE capturing so every live byte emitted after this
    // point lands in `pending` and there is no gap.
    this.subscribers.add(tap);

    const enc = new TextEncoder();
    try {
      if (this.emulatorEnabled) {
        // Authoritative snapshot from tmux capture-pane (correctly reflowed to
        // the live pane size). Bytes tmux had already rendered when the capture
        // ran may still be in flight through pipe-pane → log → poll; flushing
        // them after the snapshot applies them twice, and relative moves
        // (CR/LF, CUU, zsh PROMPT_SP) then shift the screen for good — e.g. a
        // TUI redrawing after the attach pin. So a capture only counts once no
        // byte showed up from just before it to ALIGN_SETTLE_MS after it;
        // otherwise drop those bytes (the next capture contains them) and
        // retry. A pane that never goes quiet falls back to the last capture
        // plus its trailing bytes (the overlap is then tolerated, not dropped).
        const cols = normalizeDim(paneCols, WINDOW_COLS);
        const rows = normalizeDim(paneRows, WINDOW_ROWS);
        let snap = "";
        for (let attempt = 1; attempt <= ALIGN_MAX_CAPTURES; attempt++) {
          this.poll();
          pending = [];
          snap = await this.captureSnapshot(cols, rows);
          await new Promise((r) => setTimeout(r, ALIGN_SETTLE_MS));
          this.poll();
          if (pending.length === 0) break;
          if (attempt === ALIGN_MAX_CAPTURES) {
            snapshotStats.overlaps++;
            onOverlap?.();
            logger.debug({ session: this.session, attempts: attempt }, "attach snapshot never quiet; delivering overlap");
          } else {
            snapshotStats.retries++;
          }
        }
        snapshotStats.snapshots++;
        send(enc.encode(snap));
      } else {
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
      }
    } catch (e) {
      logger.error({ session: this.session, err: e }, "replay/snapshot read failed");
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

  // Re-deliver an aligned snapshot to an already-attached subscriber (after a
  // web resize, see resize-resync.ts). `announce` runs once the subscriber is
  // detached from the live stream and before the snapshot, so the caller can
  // tell the client a reset is coming. A subscriber that detached meanwhile is
  // left alone. The legacy byte-replay path has no reflowed snapshot to offer,
  // and replaying the width-frozen log would be worse than the drift: no-op.
  async resync(send: Subscriber, paneCols: number, paneRows: number, announce: () => void, onOverlap?: () => void): Promise<void> {
    if (!this.emulatorEnabled || !this.subscribers.has(send)) return;
    this.subscribers.delete(send);
    announce();
    await this.attachWithReplay(send, paneCols, paneRows, onOverlap);
  }

  // Re-size the live emulator to track a pane resize (client viewport change).
  // No-op until the emulator is lazily built on first attach — the next attach
  // builds it at the then-current pane size anyway.
  syncEmulatorSize(cols: number, rows: number): void {
    if (this.emulator && Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) {
      this.emulator.resize(Math.floor(cols), Math.floor(rows));
    }
  }

  onEvent(fn: EventListener): () => void {
    this.eventListeners.add(fn);
    return () => { this.eventListeners.delete(fn); };
  }

  subscriberCount(): number { return this.subscribers.size; }

  bytesBroadcast(): number { return this.broadcastBytes; }

  // A quiet window lets a connection repair an overlapped busy snapshot
  // without repeatedly capturing a pane that is still producing output.
  outputQuietFor(ms: number): boolean { return Date.now() - this.lastOutputAt >= ms; }

  async stop(opts: { deleteLog?: boolean } = {}): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    logger.info({ session: this.session, deleteLog: !!opts.deleteLog }, "broadcaster stopping");
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.fd !== null) { try { closeSync(this.fd); } catch { /* ignore */ } this.fd = null; }
    if (this.emulator) { this.emulator.dispose(); this.emulator = null; }
    await this.run(["pipe-pane", "-o", "-t", `${this.session}:0.0`]).catch(() => undefined);
    // Default: KEEP the log file so history persists across hub restarts.
    // Only discard when the underlying tmux session is gone (caller passes
    // deleteLog: true from the session_removed handler) — and even then move
    // it to .trash rather than unlink, so a false removal is recoverable.
    if (opts.deleteLog) {
      try { if (existsSync(this.logPath)) trashLog(this.logPath); } catch { /* ignore */ }
    }
    for (const l of this.eventListeners) l({ kind: "stopped" });
    this.subscribers.clear();
    this.eventListeners.clear();
  }

  private emit(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.lastOutputAt = Date.now();
    this.broadcastBytes += chunk.length;
    if (this.emulator) this.emulator.write(chunk);
    for (const sub of this.subscribers) {
      try { sub(chunk); } catch { /* swallow subscriber errors */ }
    }
  }

  private poll(): void {
    if (this.fd === null) return;
    try {
      // fstat, not stat: the path may since have been swapped for a link.
      const st = fstatSync(this.fd);
      if (st.size < this.offset) {
        for (const l of this.eventListeners) l({ kind: "replay_truncated" });
        this.offset = st.size;
        return;
      }
      let read = false;
      while (true) {
        const n = readSync(this.fd, this.pollChunk, 0, this.pollChunk.length, this.offset);
        if (n <= 0) break;
        read = true;
        this.offset += n;
        this.emit(this.titleFilter.push(this.pollChunk.subarray(0, n)));
        if (n < this.pollChunk.length) break;
      }
      // A lone ESC the filter held at a chunk end is released on an idle tick.
      if (!read) this.emit(this.titleFilter.flush());
    } catch (e) {
      logger.error({ session: this.session, err: e }, "poll read error");
      for (const l of this.eventListeners) l({ kind: "error", message: String(e) });
    }
  }
}

// capture-pane output → xterm input: LF-separated lines need CRLF (no implicit
// carriage return), and the terminator after the last line would scroll the
// client one extra row, so it is dropped.
function toCrlf(s: string): string {
  return s.replace(/\r?\n$/, "").replace(/\r?\n/g, "\r\n");
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// A positive finite integer, or the fallback. Used to resolve attach-time pane
// dimensions before building the emulator.
function normalizeDim(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

export class BroadcasterRegistry {
  // `ready` is the start: every caller awaits the same one, so none gets an
  // instance whose pipe is not open yet (or never will be).
  private map = new Map<string, { b: SessionBroadcaster; ready: Promise<SessionBroadcaster> }>();
  // Stops still in flight. A same-name recreate fires stop() and get() without
  // awaiting either (main.ts); the new start waits here so the old stop's pipe
  // close and log trash cannot land on the new pipe and log.
  private stopping = new Map<string, Promise<void>>();

  constructor(private run: TmuxRunner = tmux, private emulatorEnabled?: boolean) {}

  get(session: string): Promise<SessionBroadcaster> {
    const existing = this.map.get(session);
    if (existing) return existing.ready;
    const b = new SessionBroadcaster(session, this.run, this.emulatorEnabled);
    const prior = this.stopping.get(session) ?? Promise.resolve();
    const ready = prior.then(() => b.start()).then(() => b, (e: unknown) => {
      // Don't cache a broadcaster without a pipe: a later get() (the session
      // shows up, or a retry) would return it and the session never streams.
      if (this.map.get(session)?.b === b) this.map.delete(session);
      throw e;
    });
    this.map.set(session, { b, ready });
    return ready;
  }

  has(session: string): boolean { return this.map.has(session); }

  size(): number { return this.map.size; }

  subscriberTotal(): number {
    let n = 0;
    for (const { b } of this.map.values()) n += b.subscriberCount();
    return n;
  }

  async stop(session: string, opts: { deleteLog?: boolean } = {}): Promise<void> {
    const entry = this.map.get(session);
    if (!entry) return;
    this.map.delete(session);
    const stopped = entry.b.stop(opts);
    // What a later get() waits on: settles either way, a failed stop must not
    // fail the next start. Chained after any earlier in-flight stop, so a
    // back-to-back recreate still waits for the first one (#147).
    const prior = this.stopping.get(session) ?? Promise.resolve();
    const settled: Promise<void> = prior.then(() => stopped).then(() => undefined, () => undefined).then(() => {
      if (this.stopping.get(session) === settled) this.stopping.delete(session);
    });
    this.stopping.set(session, settled);
    await stopped;
  }

  async stopAll(): Promise<void> {
    const all = Array.from(this.map.values());
    this.map.clear();
    await Promise.allSettled(all.map(({ b }) => b.stop()));
  }
}
