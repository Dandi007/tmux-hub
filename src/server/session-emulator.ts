import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { ModeShadow } from "./mode-shadow";

// xterm's _core.writeSync is marked deprecated but is the only way to achieve
// synchronous parsing: the broadcaster's attach path snapshots terminal state
// immediately after feeding bytes, requiring that the emulator state reflects
// every byte written in the SAME synchronous frame — an async term.write()
// would reintroduce a snapshot/delta overlap race. writeSync fires one
// deprecation console.warn per process on first call; that single line is
// harmless and accepted (no process-wide console.warn patch needed).

/**
 * Server-side authoritative terminal for one session. Fed the raw pipe-pane
 * byte stream; produces coherent serialize() snapshots (screen + scrollback +
 * modes) for client attach/reattach, replacing mid-sequence byte-slice replay.
 */
export class SessionEmulator {
  private term: Terminal;
  private serializer: SerializeAddon;
  private shadow: ModeShadow;
  private disposed = false;
  private readonly decoder = new TextDecoder();
  // Direct core reference: writeSync() is required for synchronous parsing so that
  // snapshot() always reflects every byte fed in the same synchronous frame (see top comment).
  private readonly core: { writeSync(data: string): void };

  constructor(
    // Mutable: resize() keeps these in sync so callers can read the live grid
    // size (used by the broadcaster to detect when a re-attach needs a resize).
    public cols: number,
    public rows: number,
    private readonly scrollbackLines: number,
  ) {
    this.term = new Terminal({ cols, rows, scrollback: scrollbackLines, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
    // Same width table as tmux and the web client (src/web/terminal.ts): emoji
    // like ⚡ are 2 columns, so absolute-column redraws land where tmux puts them.
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";
    this.shadow = new ModeShadow();
    this.shadow.attach(this.term);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.core = (this.term as any)._core;
  }

  write(data: Uint8Array | string): void {
    if (this.disposed) return;
    const text = typeof data === "string" ? data : this.decoder.decode(data, { stream: true });
    this.core.writeSync(text);
  }

  /** Coherent self-contained restore stream: reset + serialized buffer + dropped modes. */
  // Default is the constructor cap (scrollbackLines field), evaluated at call time.
  snapshot(scrollbackLines: number = this.scrollbackLines): string {
    if (this.disposed) return "\x1bc";
    const body = this.serializer.serialize({ scrollback: scrollbackLines });
    const buf = this.term.buffer.active;
    return "\x1bc" + body + this.serializeModes({ x: buf.cursorX, y: buf.cursorY });
  }

  /**
   * Tracked DEC private modes (mouse reporting, app-cursor keys, scroll region,
   * cursor visibility, bracketed paste) that `tmux capture-pane` does NOT emit.
   * Appended to a capture-pane-seeded restore stream so a reattached client
   * inherits the modes the running app set earlier in the stream.
   */
  serializeModes(cursor?: { x: number; y: number }): string {
    if (this.disposed) return "";
    const modes = this.term.modes;
    let out = this.shadow.serializeModes();
    if (modes.applicationCursorKeysMode) out += "\x1b[?1h";
    if (modes.applicationKeypadMode) out += "\x1b=";
    if (modes.bracketedPasteMode) out += "\x1b[?2004h";
    if (modes.insertMode) out += "\x1b[4h";
    if (modes.originMode) out += "\x1b[?6h";
    if (modes.reverseWraparoundMode) out += "\x1b[?45h";
    if (modes.sendFocusMode) out += "\x1b[?1004h";
    if (!modes.wraparoundMode) out += "\x1b[?7l";
    const mouse: Record<string, number> = { x10: 9, vt200: 1000, drag: 1002, any: 1003 };
    if (mouse[modes.mouseTrackingMode]) out += `\x1b[?${mouse[modes.mouseTrackingMode]}h`;
    if (cursor) {
      const row = Math.max(1, cursor.y + 1 - (modes.originMode ? this.shadow.originOffset : 0));
      out += `\x1b[${row};${cursor.x + 1}H`;
    }
    return out;
  }

  get alternateScreen(): boolean { return !this.disposed && this.term.buffer.active.type === "alternate"; }

  /** Observe live requests to leave alt, including when priming missed entry. */
  onNormalScreen(listener: () => void): void {
    this.term.parser.registerEscHandler({ final: "c" }, () => { listener(); return false; });
    this.term.parser.registerCsiHandler({ prefix: "?", final: "l" }, params => {
      if (params.some(p => p === 47 || p === 1047 || p === 1049)) listener();
      return false;
    });
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    if (cols === this.cols && rows === this.rows) return;
    this.term.resize(cols, rows);
    this.cols = cols;
    this.rows = rows;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try { this.term.dispose(); } catch { /* ignore */ }
  }
}
