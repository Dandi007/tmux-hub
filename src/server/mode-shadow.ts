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
      this.setDecset(params, true);
      return false;
    });
    term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      this.setDecset(params, false);
      return false;
    });
    term.parser.registerCsiHandler({ final: "r" }, (params) => {
      this.setScrollRegion(params);
      return false;
    });
  }

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

  private setScrollRegion(params: (number | number[])[]): void {
    // CSI r  -> reset to full screen; CSI t;b r -> set margins
    // Zero means "not specified", which is treated as reset per DECSTBM spec.
    const top = typeof params[0] === "number" ? params[0] : 0;
    const bot = typeof params[1] === "number" ? params[1] : 0;
    if (top === 0 || bot === 0) {
      this.scrollTop = null;
      this.scrollBottom = null;
    } else {
      this.scrollTop = top;
      this.scrollBottom = bot;
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
