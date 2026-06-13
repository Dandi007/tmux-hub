import { test, expect } from "bun:test";
import { Terminal } from "@xterm/headless";
import { SessionEmulator } from "../../src/server/session-emulator";

const enc = new TextEncoder();
// xterm write() is async; await the callback before reading the buffer.
async function screenOf(snapshot: string, cols = 80, rows = 24): Promise<string[]> {
  const t = new Terminal({ cols, rows, allowProposedApi: true });
  await new Promise<void>((r) => t.write(snapshot, r));
  const b = t.buffer.active, out: string[] = [];
  for (let i = 0; i < rows; i++) out.push((b.getLine(b.viewportY + i)?.translateToString(true) ?? "").replace(/\s+$/g, ""));
  return out;
}

test("snapshot round-trips the visible screen", async () => {
  const e = new SessionEmulator(80, 24, 1000);
  e.write(enc.encode("hello\r\n\x1b[31mred\x1b[0m world\r\n"));
  const snap = e.snapshot();
  const lines = await screenOf(snap);
  expect(lines[0]).toBe("hello");
  expect(lines[1]).toBe("red world");
});

test("snapshot preserves scrollback up to the cap", () => {
  const e = new SessionEmulator(80, 24, 1000);
  for (let i = 1; i <= 100; i++) e.write(enc.encode(`line ${i}\r\n`));
  const snap = e.snapshot();
  expect(snap).toContain("line 1");
  expect(snap).toContain("line 100");
});

test("snapshot appends dropped modes (cursor hidden + scroll region + SGR mouse)", () => {
  const e = new SessionEmulator(80, 24, 1000);
  e.write(enc.encode("\x1b[?1000h\x1b[?1006h\x1b[?25l\x1b[3;20rtext"));
  const snap = e.snapshot();
  expect(snap).toContain("\x1b[?1006h"); // mouse SGR encoding restored
  expect(snap).toContain("\x1b[?25l");   // cursor hidden restored
  expect(snap).toContain("\x1b[3;20r");  // scroll region restored
});

test("alt-screen state is reproduced", async () => {
  const e = new SessionEmulator(80, 24, 1000);
  e.write(enc.encode("before\r\n\x1b[?1049h\x1b[2J\x1b[HINSIDE"));
  const snap = e.snapshot();
  const t = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  await new Promise<void>((r) => t.write(snap, r));
  expect(t.buffer.active.type).toBe("alternate");
});

test("snapshot accepts a smaller scrollback override", () => {
  const e = new SessionEmulator(80, 24, 5000);
  for (let i = 1; i <= 2000; i++) e.write(enc.encode(`row ${i}\r\n`));
  const full = e.snapshot();
  const small = e.snapshot(200);
  expect(small.length).toBeLessThan(full.length);
});

test("dispose is idempotent and write-after-dispose is a no-op", () => {
  const e = new SessionEmulator(80, 24, 1000);
  e.write(enc.encode("x"));
  e.dispose();
  e.dispose();
  expect(() => e.write(enc.encode("y"))).not.toThrow();
});
