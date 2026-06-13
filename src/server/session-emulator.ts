import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
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
    public readonly cols: number,
    public readonly rows: number,
    private readonly scrollbackLines: number,
  ) {
    this.term = new Terminal({ cols, rows, scrollback: scrollbackLines, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
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
  snapshot(scrollbackLines: number = this.scrollbackLines): string {
    if (this.disposed) return "\x1bc";
    const body = this.serializer.serialize({ scrollback: scrollbackLines });
    return "\x1bc" + body + this.shadow.serializeModes();
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    this.term.resize(cols, rows);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try { this.term.dispose(); } catch { /* ignore */ }
  }
}
