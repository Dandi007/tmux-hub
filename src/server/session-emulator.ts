import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { ModeShadow } from "./mode-shadow";

// xterm's _core.writeSync is marked deprecated but is stable in 6.0.0 and is
// the only way to get synchronous parsing (so snapshot() reflects writes made
// in the same call frame). We suppress the deprecation console.warn once here.
const _origWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("writeSync is unreliable")) return;
  _origWarn(...args);
};

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
  // Internal reference to xterm core for synchronous writes
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
