// tests/unit/replay-cap.test.ts
// Unit tests for attachWithReplay replay-cap logic.
// Tests against the actual REPLAY_CAP_BYTES value (256KB default).
// Exceeds-cap fixtures use content larger than the cap; within-cap fixtures
// use content well below it.
import { describe, test, expect, afterAll } from "bun:test";
import {
  writeFileSync,
  mkdtempSync,
  rmSync,
  openSync,
  closeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── env: TMUX_HUB_LOG_DIR must be set BEFORE module import ──
const TEST_LOG_DIR = mkdtempSync(join(tmpdir(), "tht-replay-cap-"));
process.env.TMUX_HUB_LOG_DIR = TEST_LOG_DIR;

import { SessionBroadcaster } from "../../src/server/output-broadcaster";
import { REPLAY_CAP_BYTES } from "../../src/server/config";

afterAll(() => {
  try {
    rmSync(TEST_LOG_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ── helpers ──────────────────────────────────────────────────────
function setupBroadcaster(
  label: string,
  content: string,
): { b: SessionBroadcaster; unsubscribe: () => void; chunks: Uint8Array[] } {
  const b = new SessionBroadcaster(`replay-test-${label}`);
  // SessionBroadcaster's constructor mkdir's LOG_DIR; write our fixture.
  writeFileSync(b.logPath, content);

  const contentLen = Buffer.byteLength(content, "utf8");
  // Simulate post-start() state: fd open, offset at end of file.
  (b as any).fd = openSync(b.logPath, "r");
  (b as any).offset = contentLen;

  const chunks: Uint8Array[] = [];
  const unsubscribe = b.attachWithReplay((chunk) => chunks.push(chunk));
  return { b, unsubscribe, chunks };
}

function teardownBroadcaster(b: SessionBroadcaster, unsubscribe: () => void) {
  unsubscribe();
  try {
    if ((b as any).fd !== null) closeSync((b as any).fd);
  } catch {
    /* ignore */
  }
  (b as any).fd = null;
}

function firstText(chunk: Uint8Array): string {
  return Buffer.from(chunk).toString("utf8");
}

function concatData(chunks: Uint8Array[]): string {
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

// ── tests ────────────────────────────────────────────────────────
describe("REPLAY_CAP_BYTES config", () => {
  test("has a positive default", () => {
    expect(REPLAY_CAP_BYTES).toBeGreaterThan(0);
  });

  test("default is exactly 256 KB (256 * 1024)", () => {
    expect(REPLAY_CAP_BYTES).toBe(256 * 1024);
  });
});

describe("attachWithReplay replay cap", () => {
  // Content well above the default 256KB cap for truncation tests.
  // 400 KB of distinct data makes it easy to verify tail correctness.
  const LARGE = "0123456789".repeat(40_000); // 400 KB > 256 KB cap

  test("first chunk is \\x1bc RIS reset", () => {
    const { b, unsubscribe, chunks } = setupBroadcaster("ris-reset", LARGE);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(firstText(chunks[0]!)).toBe("\x1bc");
    teardownBroadcaster(b, unsubscribe);
  });

  test("replay payload ≤ REPLAY_CAP_BYTES when log exceeds cap", () => {
    const { b, unsubscribe, chunks } = setupBroadcaster("gt-cap", LARGE);

    // chunks[0] is the RIS reset; data starts at chunks[1]
    const dataChunks = chunks.slice(1);
    const totalDataBytes = dataChunks.reduce((sum, c) => sum + c.length, 0);
    expect(totalDataBytes).toBeGreaterThan(0);
    expect(totalDataBytes).toBeLessThanOrEqual(REPLAY_CAP_BYTES);
    teardownBroadcaster(b, unsubscribe);
  });

  test("replayed content is exactly the tail of the log", () => {
    const { b, unsubscribe, chunks } = setupBroadcaster("tail", LARGE);

    const dataChunks = chunks.slice(1);
    const received = concatData(dataChunks);
    const expectedTail = LARGE.slice(-REPLAY_CAP_BYTES);
    expect(received).toBe(expectedTail);
    expect(received.length).toBe(REPLAY_CAP_BYTES);
    teardownBroadcaster(b, unsubscribe);
  });

  test("replays entire file when log ≤ REPLAY_CAP_BYTES", () => {
    // ~10 KB — well below the 256 KB cap.
    const content = "SHORT_LOG_" + "x".repeat(10_000);
    const { b, unsubscribe, chunks } = setupBroadcaster("le-cap", content);

    const dataChunks = chunks.slice(1);
    const totalDataBytes = dataChunks.reduce((sum, c) => sum + c.length, 0);
    expect(totalDataBytes).toBe(Buffer.byteLength(content, "utf8"));

    const received = concatData(dataChunks);
    expect(received).toBe(content);
    teardownBroadcaster(b, unsubscribe);
  });

  test("no data replay when offset is 0 (empty log)", () => {
    const b = new SessionBroadcaster("replay-test-empty");
    writeFileSync(b.logPath, "");
    (b as any).fd = openSync(b.logPath, "r");
    (b as any).offset = 0;

    const chunks: Uint8Array[] = [];
    const unsubscribe = b.attachWithReplay((chunk) => chunks.push(chunk));

    // Only the \x1bc reset, no data payload.
    expect(chunks.length).toBe(1);
    expect(firstText(chunks[0]!)).toBe("\x1bc");

    teardownBroadcaster(b, unsubscribe);
  });

  test("exact cap boundary: log == REPLAY_CAP_BYTES replays full file", () => {
    const content = "A".repeat(REPLAY_CAP_BYTES); // exactly 256 KB
    const { b, unsubscribe, chunks } = setupBroadcaster("exact-cap", content);

    const dataChunks = chunks.slice(1);
    const totalDataBytes = dataChunks.reduce((sum, c) => sum + c.length, 0);
    expect(totalDataBytes).toBe(REPLAY_CAP_BYTES);

    const received = concatData(dataChunks);
    expect(received).toBe(content);
    teardownBroadcaster(b, unsubscribe);
  });

  test("exact cap+1 boundary: log == REPLAY_CAP_BYTES + 1 replays tail of cap bytes", () => {
    // Use distinct head/tail: 256KB of "A" + "B" = 256KB+1 total.
    // Head = all A, Tail = 256KB-1 A + "B" — observably different.
    const content = "A".repeat(REPLAY_CAP_BYTES) + "B";
    const { b, unsubscribe, chunks } = setupBroadcaster(
      "cap-plus-1",
      content,
    );

    const dataChunks = chunks.slice(1);
    const totalDataBytes = dataChunks.reduce((sum, c) => sum + c.length, 0);
    expect(totalDataBytes).toBe(REPLAY_CAP_BYTES);

    const received = concatData(dataChunks);
    // Should be the *tail* — skip the first byte "A", ending with "B".
    const expectedTail = content.slice(-REPLAY_CAP_BYTES); // (CAP-1)*A + B
    expect(received).toBe(expectedTail);
    expect(received.endsWith("B")).toBe(true);
    // Must NOT be the head (all A's).
    expect(received).not.toBe(content.slice(0, REPLAY_CAP_BYTES));
    teardownBroadcaster(b, unsubscribe);
  });

  test("subscribe/unsubscribe from attachWithReplay", () => {
    const content = "HELLO";
    const { b, unsubscribe, chunks } = setupBroadcaster("sub", content);

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(b.subscriberCount()).toBeGreaterThanOrEqual(1);

    unsubscribe();
    // After unsubscribe, the subscriber count should decrease.
    const after = b.subscriberCount();
    expect(after).toBeLessThanOrEqual(1);
    teardownBroadcaster(b, unsubscribe);
  });

  test("fallback to plain attach when fd is null", () => {
    const b = new SessionBroadcaster("replay-test-no-fd");
    // Don't set fd — simulate broadcaster that hasn't started.
    (b as any).fd = null;

    const chunks: Uint8Array[] = [];
    const unsubscribe = b.attachWithReplay((chunk) => chunks.push(chunk));

    // Should NOT have sent \x1bc — that only happens with fd set.
    // Falls back to plain attach which just adds subscriber.
    expect(chunks.length).toBe(0);
    expect(b.subscriberCount()).toBeGreaterThanOrEqual(1);

    unsubscribe();
  });
});