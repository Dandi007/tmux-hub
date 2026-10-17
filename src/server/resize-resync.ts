// src/server/resize-resync.ts
// After a web resize, the browser's xterm and tmux reflow the screen
// independently and disagree on soft-wrapped lines; the app's SIGWINCH redraw
// then lands on different rows and the client never heals (fidelity oracle:
// an extra zsh PROMPT_SP row). The fix is to re-send an aligned snapshot once
// the resize settles. This class decides WHEN: debounced to the last resize of
// a burst, only if the pane changed size since the last snapshot (even if it
// came back to the same size: the app redrew in between), after the initial
// attach, and never two at once on the same connection.
import { createLogger } from "./logger";

const logger = createLogger("resize-resync");

export const RESYNC_DEBOUNCE_MS = 200;

export class ResyncScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void>;
  private dirty = false;
  private disposed = false;

  constructor(
    private paneCols: number,
    private paneRows: number,
    ready: Promise<unknown>,
    private readonly resync: (cols: number, rows: number) => Promise<void>,
    private readonly delayMs: number = RESYNC_DEBOUNCE_MS,
  ) {
    this.chain = ready.then(() => undefined, () => undefined);
  }

  resized(cols: number, rows: number): void {
    if (this.disposed) return;
    if (cols !== this.paneCols || rows !== this.paneRows) this.dirty = true;
    this.paneCols = cols;
    this.paneRows = rows;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.chain = this.chain.then(() => this.fire());
    }, this.delayMs);
  }

  private async fire(): Promise<void> {
    if (this.disposed || !this.dirty) return;
    this.dirty = false;
    const cols = this.paneCols;
    const rows = this.paneRows;
    try {
      await this.resync(cols, rows);
    } catch (e) {
      logger.warn({ err: e, cols, rows }, "resize resync failed");
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}
