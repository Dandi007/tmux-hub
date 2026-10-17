import { describe, test, expect } from "bun:test";
import { TitleSeqFilter } from "../../src/server/title-seq-filter";

// zsh (oh-my-zsh termsupport) under TERM=tmux* emits GNU screen's window-name
// sequence `ESC k <name> ESC \` before every command. tmux consumes it; xterm.js
// does not know it and PRINTS the name ("printf" landed on the output line and
// was only partly overwritten — RSI round 9). The broadcaster strips it.
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
function run(chunks: string[]): string {
  const f = new TitleSeqFilter();
  return chunks.map((c) => dec(f.push(enc(c)))).join("") + dec(f.flush());
}

describe("TitleSeqFilter", () => {
  test("strips ESC k … ESC \\ and keeps everything around it", () => {
    expect(run(["\x1b]2;title\x1b\\\x1bkprintf\x1b\\⚡\x1b[3GA"])).toBe("\x1b]2;title\x1b\\⚡\x1b[3GA");
  });
  test("BEL also terminates it", () => {
    expect(run(["a\x1bkvim\x07b"])).toBe("ab");
  });
  test("survives splits at every byte", () => {
    const s = "x\x1bkprintf\x1b\\y\x1b[1mz\x1b";
    const bytes = enc(s);
    for (let cut = 1; cut < bytes.length; cut++) {
      const f = new TitleSeqFilter();
      const out = dec(f.push(bytes.subarray(0, cut))) + dec(f.push(bytes.subarray(cut))) + dec(f.flush());
      expect(out).toBe("xy\x1b[1mz\x1b");
    }
  });
  test("other escapes, a lone trailing ESC and ESC ESC pass through", () => {
    expect(run(["\x1b[?1049h\x1b>", "\x1b\x1b[A", "\x1b"])).toBe("\x1b[?1049h\x1b>\x1b\x1b[A\x1b");
  });
  test("an unterminated name gives up after the cap instead of eating the stream", () => {
    const out = run(["\x1bk" + "n".repeat(2000) + "VISIBLE"]);
    expect(out.endsWith("VISIBLE")).toBe(true);
    expect(out.length).toBeLessThan(2000);
  });
  test("ESC + non-backslash inside the name ends it; the escape is kept", () => {
    expect(run(["\x1bkname\x1b[1mX"])).toBe("\x1b[1mX");
  });
});
