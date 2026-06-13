import { test, expect } from "bun:test";
import { Terminal } from "@xterm/headless";
import { SessionEmulator } from "../../src/server/session-emulator";

const enc = new TextEncoder();

// Render a self-contained restore stream into a fresh client terminal and read
// back its full buffer text. xterm's Terminal.write() is asynchronous (buffered
// + flushed on a microtask), so we MUST await the write callback before reading
// the buffer — otherwise we observe an empty pre-flush buffer. (The emulator's
// own writeSync path is synchronous; only these client-side reconstructions are
// async.)
async function render(stream: string, cols = 80, rows = 24): Promise<Terminal> {
  const t = new Terminal({ cols, rows, allowProposedApi: true });
  await new Promise<void>((res) => t.write(stream, res));
  return t;
}

function bufferText(t: Terminal): string {
  const b = t.buffer.active, o: string[] = [];
  for (let i = 0; i < b.length; i++) {
    o.push((b.getLine(i)?.translateToString(true) ?? "").replace(/\s+$/g, ""));
  }
  return o.join("\n").replace(/\n+$/g, "");
}

// spike3-G1b/G1c: a late joiner that applies snapshot, then ONLY the deltas
// that arrive after the snapshot offset, converges to the authority — and
// must NOT double-apply a delta already folded into the snapshot.
test("snapshot + post-snapshot deltas converge without overlap", async () => {
  const authority = new SessionEmulator(80, 24, 1000);
  authority.write(enc.encode("AAA\r\n"));
  const snap = authority.snapshot();          // bound here
  const delta = enc.encode("BBB\r\n");
  authority.write(delta);                       // live delta after snapshot

  // late joiner: snapshot THEN delta (correct ordering)
  const joiner = await render(snap);
  await new Promise<void>((res) => joiner.write(new TextDecoder().decode(delta), res));

  // authority's post-delta snapshot rendered into a fresh client is the source
  // of truth; the joiner (snapshot + delta) must match it exactly — no missing
  // BBB (gap) and no doubled AAA (overlap).
  const authClient = await render(authority.snapshot());
  expect(bufferText(joiner)).toBe(bufferText(authClient));
}, 5000);

// spike4: after the authority resizes, a snapshot taken post-resize re-renders
// coherently at the new size (resize == re-attach; clients must be re-snapshotted).
test("post-resize snapshot is coherent at the new size", async () => {
  const e = new SessionEmulator(80, 24, 1000);
  e.write(enc.encode("X".repeat(120) + "\r\n"));
  e.resize(40, 24);
  const snap = e.snapshot();
  const t = await render(snap, 40, 24);
  const xCount = (bufferText(t).match(/X/g) ?? []).length;
  expect(xCount).toBe(120); // no character loss on reflow
}, 5000);
