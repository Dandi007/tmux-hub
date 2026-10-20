import type { Terminal } from "@xterm/headless";

/**
 * Tracks the terminal modes that SerializeAddon.serialize() does NOT restore:
 *   - mouse encoding: DECSET 1006 (SGR) / 1005 / 1015
 *   - scroll region: DECSTBM (CSI t;b r)
 *   - cursor visibility: DECTCEM (CSI ?25 h/l)
 * Supported mode hooks return false to observe normal parsing. DECSTR is
 * ignored to match tmux instead of applying xterm's different soft reset. serializeModes() emits the restore sequences to
 * append after serialize() so these tracked modes survive attach.
 */
export class ModeShadow {
  private mouseEncoding: number | null = null; // 1006 | 1005 | 1015
  private cursorHidden = false;
  private scrollTop: number | null = null;
  private scrollBottom: number | null = null;

  attach(term: Terminal): void {
    term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
      this.setDecset(params, true);
      return false;
    });
    term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      this.setDecset(params, false);
      return false;
    });
    term.parser.registerCsiHandler({ final: "r" }, (params) => {
      this.setScrollRegion(params, term.rows);
      return false;
    });
    term.parser.registerEscHandler({ final: "c" }, () => {
      this.mouseEncoding = null;
      this.cursorHidden = false;
      this.scrollTop = this.scrollBottom = null;
      return false;
    });
    // tmux ignores DECSTR (verified against 3.6); xterm's soft reset would
    // otherwise diverge from the authoritative pane before the next capture.
    term.parser.registerCsiHandler({ intermediates: "!", final: "p" }, () => true);
    let rows = term.rows;
    term.onResize(size => {
      // tmux preserves margins for width-only changes and resets on row changes.
      if (size.rows !== rows) this.scrollTop = this.scrollBottom = null;
      rows = size.rows;
    });
  }

  get restoresMargins(): boolean { return this.scrollTop !== null; }

  get originOffset(): number { return (this.scrollTop ?? 1) - 1; }

  private setDecset(params: (number | number[])[], on: boolean): void {
    for (const p of params) {
      if (typeof p !== "number") continue;
      if (p === 25) {
        this.cursorHidden = !on;
      } else if (p === 1006 || p === 1005 || p === 1015) {
        if (on) this.mouseEncoding = p;
        else if (this.mouseEncoding === p) this.mouseEncoding = null;
      }
    }
  }

  private setScrollRegion(params: (number | number[])[], rows: number): void {
    const top = typeof params[0] === "number" && params[0] > 0 ? params[0] : 1;
    const bottom = Math.min(rows, typeof params[1] === "number" && params[1] > 0 ? params[1] : rows);
    if (top >= bottom) return; // Invalid margins are ignored by tmux/xterm.
    if (top === 1 && bottom === rows) this.scrollTop = this.scrollBottom = null;
    else { this.scrollTop = top; this.scrollBottom = bottom; }
  }

  serializeModes(): string {
    let out = "";
    if (this.scrollTop != null && this.scrollBottom != null) {
      out += `\x1b[${this.scrollTop};${this.scrollBottom}r`;
    }
    if (this.cursorHidden) out += "\x1b[?25l";
    if (this.mouseEncoding != null) out += `\x1b[?${this.mouseEncoding}h`;
    return out;
  }
}
