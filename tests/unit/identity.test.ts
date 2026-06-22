import { describe, test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { verifyGateIdentity, gateIdentityFromHeaders, GATE_APP } from "../../src/server/identity";

const KEY = "inject-shared-secret-aaaaaaaaaaaa";

// Build a signature exactly as gate-auth inject.go:signIdentity does:
//   `${ts}.${hmac_sha256(key, "uid|app|ts")}`
function sign(uid: string, app: string, ts: number, key = KEY): string {
  const hex = createHmac("sha256", key).update(`${uid}|${app}|${ts}`).digest("hex");
  return `${ts}.${hex}`;
}

describe("verifyGateIdentity", () => {
  const now = 1_750_000_000;

  test("valid signature within skew → true", () => {
    expect(verifyGateIdentity("u123", GATE_APP, sign("u123", GATE_APP, now), KEY, now, 300)).toBe(true);
  });

  test("ts at skew edge → true; just beyond → false", () => {
    expect(verifyGateIdentity("u1", GATE_APP, sign("u1", GATE_APP, now - 300), KEY, now, 300)).toBe(true);
    expect(verifyGateIdentity("u1", GATE_APP, sign("u1", GATE_APP, now - 301), KEY, now, 300)).toBe(false);
  });

  test("future ts beyond skew → false", () => {
    expect(verifyGateIdentity("u1", GATE_APP, sign("u1", GATE_APP, now + 301), KEY, now, 300)).toBe(false);
  });

  test("wrong app → false (sig bound to app)", () => {
    expect(verifyGateIdentity("u1", GATE_APP, sign("u1", "todo", now), KEY, now, 300)).toBe(false);
  });

  test("wrong key → false", () => {
    expect(verifyGateIdentity("u1", GATE_APP, sign("u1", GATE_APP, now, "other-key"), KEY, now, 300)).toBe(false);
  });

  test("uid mismatch (sig signed for different uid) → false", () => {
    expect(verifyGateIdentity("attacker", GATE_APP, sign("victim", GATE_APP, now), KEY, now, 300)).toBe(false);
  });

  test("tampered hmac → false", () => {
    const sig = sign("u1", GATE_APP, now);
    expect(verifyGateIdentity("u1", GATE_APP, sig.slice(0, -1) + "0", KEY, now, 300)).toBe(false);
  });

  test("malformed sig (no dot) → false", () => {
    expect(verifyGateIdentity("u1", GATE_APP, "garbage", KEY, now, 300)).toBe(false);
  });

  test("non-numeric ts → false", () => {
    expect(verifyGateIdentity("u1", GATE_APP, `abc.${"0".repeat(64)}`, KEY, now, 300)).toBe(false);
  });

  test("empty uid / sig / key → false", () => {
    expect(verifyGateIdentity("", GATE_APP, sign("", GATE_APP, now), KEY, now, 300)).toBe(false);
    expect(verifyGateIdentity("u1", GATE_APP, "", KEY, now, 300)).toBe(false);
    expect(verifyGateIdentity("u1", GATE_APP, sign("u1", GATE_APP, now), "", now, 300)).toBe(false);
  });
});

describe("gateIdentityFromHeaders", () => {
  const now = 1_750_000_000;

  test("valid headers → returns uid", () => {
    const uid = "user-42";
    const sig = sign(uid, GATE_APP, now);
    expect(gateIdentityFromHeaders({ uid, sig }, KEY, now)).toBe(uid);
  });

  test("missing headers → null", () => {
    expect(gateIdentityFromHeaders({ uid: undefined, sig: undefined }, KEY, now)).toBeNull();
    expect(gateIdentityFromHeaders({ uid: "u1", sig: undefined }, KEY, now)).toBeNull();
  });

  test("empty key (gate-id not configured) → null (inert, falls back to other auth)", () => {
    const sig = sign("u1", GATE_APP, now);
    expect(gateIdentityFromHeaders({ uid: "u1", sig }, "", now)).toBeNull();
  });

  test("invalid signature → null", () => {
    expect(gateIdentityFromHeaders({ uid: "u1", sig: "bad.sig" }, KEY, now)).toBeNull();
  });
});
