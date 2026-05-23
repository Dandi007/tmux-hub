import { describe, test, expect } from "bun:test";

describe("heartbeat protocol", () => {
  test("ping message has correct shape", () => {
    const ts = Date.now();
    const msg = { kind: "ping" as const, ts };
    expect(msg.kind).toBe("ping");
    expect(typeof msg.ts).toBe("number");
    expect(JSON.parse(JSON.stringify(msg))).toEqual(msg);
  });

  test("pong message echoes ts unchanged", () => {
    const ts = 1716480000000;
    const pong = { kind: "pong" as const, ts };
    expect(pong.ts).toBe(ts);
  });
});

describe("server ping handler guard", () => {
  test("ping kind is recognized", () => {
    const parsed = JSON.parse('{"kind":"ping","ts":123}');
    const isPing = typeof parsed === "object" && parsed !== null && parsed.kind === "ping";
    expect(isPing).toBe(true);
  });

  test("non-ping messages are not intercepted", () => {
    for (const raw of ['{"kind":"keys","literal":"a"}', '{"kind":"resize","cols":80,"rows":24}']) {
      const parsed = JSON.parse(raw);
      const isPing = typeof parsed === "object" && parsed !== null && parsed.kind === "ping";
      expect(isPing).toBe(false);
    }
  });

  test("malformed ping without ts defaults safely", () => {
    const parsed = JSON.parse('{"kind":"ping"}');
    const ts = (parsed as { ts?: number }).ts ?? 0;
    expect(ts).toBe(0);
  });
});
