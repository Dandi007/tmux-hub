import type { Terminal } from "@xterm/headless";

/**
 * Tracks the terminal modes that SerializeAddon.serialize() does NOT restore:
 *   - mouse encoding: DECSET 1006 (SGR) / 1005 / 1015
 *   - scroll region: DECSTBM (CSI t;b r)
 *   - cursor visibility: DECTCEM (CSI ?25 h/l)
 * Hooks are registered with return-false so xterm still processes the sequence
 * normally; we only observe. serializeModes() emits the restore sequences to
 * append after serialize() so a fresh client is mode-complete on attach.
 */
export class ModeShadow {
  private mouseEncoding: number | null = null; // 1006 | 1005 | 1015
  private cursorHidden = false;
  private scrollTop: number | null = null;
  private scrollBottom: number | null = null;

  attach(term: Terminal): void {
    term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
      this.setDecset(params as number[], true);
      return false;
    });
    term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      this.setDecset(params as number[], false);
      return false;
    });
    term.parser.registerCsiHandler({ final: "r" }, (params) => {
      this.setScrollRegion(params as number[]);
      return false;
    });
  }

  private setDecset(params: number[], on: boolean): void {
    for (const p of params) {
      if (p === 25) {
        this.cursorHidden = !on;
      } else if (p === 1006 || p === 1005 || p === 1015) {
        if (on) this.mouseEncoding = p;
        else if (this.mouseEncoding === p) this.mouseEncoding = null;
      }
    }
  }

  private setScrollRegion(params: number[]): void {
    // CSI r  -> reset to full screen; CSI t;b r -> set margins
    if (params.length < 2 || !params[0] || !params[1]) {
      this.scrollTop = null;
      this.scrollBottom = null;
    } else {
      this.scrollTop = params[0]!;
      this.scrollBottom = params[1]!;
    }
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
