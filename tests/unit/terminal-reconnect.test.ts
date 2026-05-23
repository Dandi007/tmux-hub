import { describe, test, expect } from "bun:test";

describe("reconnect backoff calculation", () => {
  const BASE = 500;
  const MAX = 30_000;
  const JITTER = 0.3;

  function calcDelay(attempt: number, rand = 0.5): number {
    const delay = Math.min(BASE * Math.pow(2, attempt), MAX);
    return delay * (1 + (rand * 2 - 1) * JITTER);
  }

  test("attempt 0 base delay is 500ms", () => {
    expect(calcDelay(0, 0.5)).toBe(500);
  });

  test("attempt 1 doubles to 1000ms", () => {
    expect(calcDelay(1, 0.5)).toBe(1000);
  });

  test("delay caps at 30s for large attempt numbers", () => {
    expect(calcDelay(100, 0.5)).toBe(30_000);
  });

  test("jitter at attempt 0 ranges from 350ms to 650ms", () => {
    expect(calcDelay(0, 0)).toBe(350);
    expect(calcDelay(0, 1)).toBe(650);
  });

  test("8 retries total under 3 minutes even with max jitter", () => {
    let total = 0;
    for (let i = 0; i < 8; i++) total += calcDelay(i, 1);
    expect(total).toBeLessThan(180_000);
    expect(total).toBeGreaterThan(30_000);
  });
});

describe("send queue eviction", () => {
  const MAX_BYTES = 65_536;

  test("evicts oldest when capacity exceeded", () => {
    const queue: string[] = [];
    let bytes = 0;
    const msg = "x".repeat(1024);
    for (let i = 0; i < 70; i++) {
      while (bytes + msg.length > MAX_BYTES && queue.length > 0) {
        bytes -= queue.shift()!.length;
      }
      queue.push(msg);
      bytes += msg.length;
    }
    expect(bytes).toBeLessThanOrEqual(MAX_BYTES);
    expect(queue.length).toBe(64);
  });

  test("empty queue accepts first message", () => {
    const queue: string[] = [];
    let bytes = 0;
    const msg = '{"kind":"keys","literal":"a"}';
    queue.push(msg);
    bytes += msg.length;
    expect(queue.length).toBe(1);
    expect(bytes).toBeLessThan(MAX_BYTES);
  });
});

describe("state transitions", () => {
  const valid: Record<string, string[]> = {
    connected: ["reconnecting"],
    reconnecting: ["connected", "dead"],
    dead: ["reconnecting"],
  };

  test("connected → reconnecting is valid", () => {
    expect(valid["connected"]).toContain("reconnecting");
  });

  test("reconnecting → connected is valid (successful reconnect)", () => {
    expect(valid["reconnecting"]).toContain("connected");
  });

  test("reconnecting → dead is valid (max retries)", () => {
    expect(valid["reconnecting"]).toContain("dead");
  });

  test("dead → reconnecting is valid (manual retry or dead probe)", () => {
    expect(valid["dead"]).toContain("reconnecting");
  });

  test("connected cannot go directly to dead", () => {
    expect(valid["connected"]).not.toContain("dead");
  });
});
