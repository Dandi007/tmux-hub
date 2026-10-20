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
const REPAIR_QUIET_MS = 100;

export class ResyncScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void>;
  private repairTimer: ReturnType<typeof setTimeout> | null = null;
  private quiet: (() => boolean) | null = null;
  private dirty = false;
  private urgentRepair = false;
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

  // Share the resize chain so repair never races initial attach or another
  // snapshot. A pending request costs a quiet check, not a capture, while busy.
  repairWhenQuiet(isQuiet: () => boolean): void {
    if (this.disposed) return;
    this.quiet = isQuiet;
    this.scheduleRepair();
  }

  // A known invalid saved grid needs a bounded capture even if output stays
  // busy. Use the same chain and coalesce with resize/overlap repair.
  repairNow(delayMs = REPAIR_QUIET_MS): void {
    if (this.disposed) return;
    this.urgentRepair = true;
    this.scheduleRepair(delayMs);
  }

  private scheduleRepair(delayMs = REPAIR_QUIET_MS): void {
    if (this.repairTimer) return;
    this.repairTimer = setTimeout(() => {
      this.repairTimer = null;
      this.chain = this.chain.then(async () => {
        if (this.disposed || (!this.quiet && !this.urgentRepair)) return;
        if (!this.urgentRepair && this.quiet && !this.quiet()) { this.scheduleRepair(); return; }
        await this.fire(true);
      });
    }, delayMs);
  }

  private async fire(repair = false): Promise<void> {
    if (this.disposed || (!this.dirty && !repair)) return;
    this.dirty = false;
    this.urgentRepair = false;
    // A resize snapshot satisfies the pending repair too. If it overlaps,
    // its callback will request a new quiet window during the await below.
    this.quiet = null;
    if (this.repairTimer) { clearTimeout(this.repairTimer); this.repairTimer = null; }
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
    this.urgentRepair = false;
    this.quiet = null;
    if (this.repairTimer) { clearTimeout(this.repairTimer); this.repairTimer = null; }
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}
