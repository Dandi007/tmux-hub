// identity.ts 行为测试：验签逻辑与 GATE_APP 默认值。
// 本文件静态导入 identity.ts，测试 verifyGateIdentity / gateIdentityFromHeaders
// 的核心语义。GATE_APP env 注入测试见 identity.env.test.ts。
import { test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import {
  GATE_APP,
  GATE_SKEW_SECONDS,
  gateIdentityFromHeaders,
  verifyGateIdentity,
} from "./identity";

/** 测试用：生成与 gate-auth signIdentity 对称的签名。 */
function sign(uid: string, app: string, key: string, ts: number): string {
  const hmac = createHmac("sha256", key)
    .update(`${uid}|${app}|${ts}`)
    .digest("hex");
  return `${ts}.${hmac}`;
}

const KEY = "test-gate-key-abc";
const UID = "user-42";

// ── verifyGateIdentity ───────────────────────────────────────────────────────

test("verifyGateIdentity: app=hub 正确签名通过", () => {
  const ts = Math.floor(Date.now() / 1000);
  const sig = sign(UID, "hub", KEY, ts);
  expect(verifyGateIdentity(UID, "hub", sig, KEY, ts, 300)).toBe(true);
});

test("verifyGateIdentity: app=hub-dogfood 正确签名通过", () => {
  const ts = Math.floor(Date.now() / 1000);
  const sig = sign(UID, "hub-dogfood", KEY, ts);
  expect(verifyGateIdentity(UID, "hub-dogfood", sig, KEY, ts, 300)).toBe(true);
});

test("verifyGateIdentity: hub 签名不通过 hub-dogfood（跨实例隔离）", () => {
  const ts = Math.floor(Date.now() / 1000);
  const sig = sign(UID, "hub", KEY, ts);
  expect(verifyGateIdentity(UID, "hub-dogfood", sig, KEY, ts, 300)).toBe(false);
});

test("verifyGateIdentity: hub-dogfood 签名不通过 hub（跨实例隔离）", () => {
  const ts = Math.floor(Date.now() / 1000);
  const sig = sign(UID, "hub-dogfood", KEY, ts);
  expect(verifyGateIdentity(UID, "hub", sig, KEY, ts, 300)).toBe(false);
});

test("verifyGateIdentity: 时钟偏移超过 skew 时返回 false", () => {
  const now = Math.floor(Date.now() / 1000);
  const ts = now - GATE_SKEW_SECONDS - 10;
  const sig = sign(UID, "hub", KEY, ts);
  expect(verifyGateIdentity(UID, "hub", sig, KEY, now, GATE_SKEW_SECONDS)).toBe(false);
});

test("verifyGateIdentity: 缺少必要字段时返回 false", () => {
  const ts = Math.floor(Date.now() / 1000);
  const sig = sign(UID, "hub", KEY, ts);
  expect(verifyGateIdentity("", "hub", sig, KEY, ts, 300)).toBe(false);
  expect(verifyGateIdentity(UID, "", sig, KEY, ts, 300)).toBe(false);
  expect(verifyGateIdentity(UID, "hub", sig, "", ts, 300)).toBe(false);
});

// ── gateIdentityFromHeaders ─────────────────────────────────────────────────

test("gateIdentityFromHeaders: 签名与 GATE_APP 匹配时返回 uid", () => {
  const ts = Math.floor(Date.now() / 1000);
  const sig = sign(UID, GATE_APP, KEY, ts);
  expect(gateIdentityFromHeaders({ uid: UID, sig }, KEY, ts, 300)).toBe(UID);
});

test("gateIdentityFromHeaders: key 未配置（空串）时返回 null", () => {
  const ts = Math.floor(Date.now() / 1000);
  const sig = sign(UID, GATE_APP, KEY, ts);
  expect(gateIdentityFromHeaders({ uid: UID, sig }, "", ts, 300)).toBeNull();
});

test("gateIdentityFromHeaders: uid 缺失时返回 null", () => {
  const ts = Math.floor(Date.now() / 1000);
  const sig = sign(UID, GATE_APP, KEY, ts);
  expect(gateIdentityFromHeaders({ uid: undefined, sig }, KEY, ts, 300)).toBeNull();
});

test("gateIdentityFromHeaders: sig 缺失时返回 null", () => {
  const ts = Math.floor(Date.now() / 1000);
  expect(gateIdentityFromHeaders({ uid: UID, sig: undefined }, KEY, ts, 300)).toBeNull();
});
