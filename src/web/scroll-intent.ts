import type { Terminal } from "xterm";

type ScrollSample = { type: "normal" | "alternate"; baseY: number; viewportY: number };

/** A navigation changes viewportY at a stable scrollback origin. Replay writes
 * grow/reset that origin instead. Programmatic resize/restore samples establish
 * a new baseline without being interpreted as navigation. */
export class ScrollIntentTracker {
  private previous: ScrollSample | null = null;

  observe(current: ScrollSample, allowed: boolean): number | null {
    const previous = this.previous;
    this.previous = current;
    if (!allowed || !previous || current.type !== "normal" || previous.type !== "normal"
      || current.baseY <= 0 || current.baseY !== previous.baseY
      || current.viewportY === previous.viewportY) return null;
    return Math.max(0, current.baseY - current.viewportY);
  }
}

export function observeScrollIntent(
  term: Terminal,
  viewport: HTMLElement | null,
  allowed: () => boolean,
  onIntent: (lines: number) => void,
): { programmatic: (action: () => void) => void; dispose: () => void } {
  const tracker = new ScrollIntentTracker();
  let programmatic = false;
  const sample = (allow: boolean): void => {
    const b = term.buffer.active;
    const lines = tracker.observe({ type: b.type, baseY: b.baseY, viewportY: b.viewportY }, allow);
    if (lines !== null) onIntent(lines);
  };
  const changed = (): void => sample(!programmatic && allowed());
  const sync = (): void => sample(false);
  sync();
  const subscriptions = [term.onScroll(changed), term.onResize(sync), term.buffer.onBufferChange(sync)];
  // xterm suppresses its public onScroll for native viewport scrolls. Its own
  // DOM listener was registered by open() before ours, so buffer.viewportY is
  // already updated here (wheel, scrollbar, and touch momentum all use it).
  // xterm 5.3 can clamp scrollTop while shrinking replay history without
  // marking the resulting DOM scroll as programmatic. If live output parses
  // before that queued event, the old DOM bottom scrolls the buffer backwards.
  // At a shared bottom, synchronize geometry BEFORE xterm handles the event.
  // A wheel/drag away from DOM bottom, or a buffer already in history, must
  // keep its ordinary navigation path. Do not suppress any scroll events.
  const syncFollowingBottom = (): void => {
    if (!viewport || viewport.offsetParent === null) return;
    const b = term.buffer.active;
    if (b.type !== "normal" || b.viewportY !== b.baseY
      || viewport.scrollTop < viewport.scrollHeight - viewport.clientHeight - 1) return;
    // Pinned xterm 5.3 has no public immediate viewport synchronization API.
    const internal = term as unknown as {
      _core?: { viewport?: { syncScrollArea(immediate: boolean): void } };
    };
    internal._core?.viewport?.syncScrollArea(true);
  };
  viewport?.addEventListener("scroll", syncFollowingBottom, true);
  viewport?.addEventListener("scroll", changed);
  return {
    programmatic: (action) => {
      programmatic = true;
      try { action(); } finally { sync(); programmatic = false; }
    },
    dispose: () => {
      viewport?.removeEventListener("scroll", syncFollowingBottom, true);
      viewport?.removeEventListener("scroll", changed);
      for (const subscription of subscriptions) subscription.dispose();
    },
  };
}
