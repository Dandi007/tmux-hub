import { test, expect } from "bun:test";
import { Terminal } from "@xterm/headless";
import { ModeShadow } from "../../src/server/mode-shadow";

// xterm write() defers parsing to the next microtask; we must await each write
// so that CSI handler callbacks fire before serializeModes() is called.
async function feed(seqs: string[]): Promise<string> {
  const t = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const shadow = new ModeShadow();
  shadow.attach(t);
  for (const s of seqs) await new Promise<void>((r) => t.write(s, r));
  return shadow.serializeModes();
}

test("captures mouse SGR encoding 1006", async () => {
  expect(await feed(["\x1b[?1000h", "\x1b[?1006h"])).toContain("\x1b[?1006h");
});

test("captures cursor-hidden DECTCEM", async () => {
  expect(await feed(["\x1b[?25l"])).toContain("\x1b[?25l");
});

test("does not emit cursor-hide when cursor visible", async () => {
  expect(await feed(["\x1b[?25l", "\x1b[?25h"])).not.toContain("?25l");
});

test("captures scroll region DECSTBM", async () => {
  expect(await feed(["\x1b[3;10r"])).toContain("\x1b[3;10r");
});

test("DECSTBM reset (no params) clears region", async () => {
  expect(await feed(["\x1b[3;10r", "\x1b[r"])).not.toContain(";10r");
});

test("mouse encoding cleared on 1006l", async () => {
  expect(await feed(["\x1b[?1006h", "\x1b[?1006l"])).not.toContain("?1006h");
});

test("emits nothing for a clean terminal", async () => {
  expect(await feed([])).toBe("");
});
