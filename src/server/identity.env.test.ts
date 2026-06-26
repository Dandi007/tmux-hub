// GATE_APP 环境变量注入测试。
//
// 设计约束：
//   - 本文件不静态导入 identity.ts（避免模块级常量在 env 设定前求值）。
//   - process.env 赋值在模块求值阶段（早于所有 test 函数体）执行，
//     随后动态 import identity.ts 时常量才被求值 → 可测 env 注入路径。
//   - Bun test 每个文件独立 worker，env 修改不污染其他测试文件。
//
// TDD: 实现前 GATE_APP 硬编码 "hub"，以下测试 FAIL；
//      改为 process.env.TMUX_HUB_GATE_APP ?? "hub" 后 PASS。
process.env.TMUX_HUB_GATE_APP = "hub-dogfood";

import { test, expect } from "bun:test";
import { createHmac } from "node:crypto";

test("GATE_APP 读取 TMUX_HUB_GATE_APP=hub-dogfood（env 注入路径）", async () => {
  const { GATE_APP } = await import("./identity");
  expect(GATE_APP).toBe("hub-dogfood");
});

test("gateIdentityFromHeaders 用 hub-dogfood app 验签（env 注入后）", async () => {
  const { GATE_APP, gateIdentityFromHeaders } = await import("./identity");
  expect(GATE_APP).toBe("hub-dogfood");

  const uid = "dogfood-user-1";
  const key = "dogfood-secret-key";
  const ts = Math.floor(Date.now() / 1000);
  // 使用 hub-dogfood 作为 app 生成签名
  const hmac = createHmac("sha256", key)
    .update(`${uid}|hub-dogfood|${ts}`)
    .digest("hex");
  const sig = `${ts}.${hmac}`;

  expect(gateIdentityFromHeaders({ uid, sig }, key, ts, 300)).toBe(uid);
});

test("gateIdentityFromHeaders 拒绝 hub 签名（env=hub-dogfood 时跨实例隔离）", async () => {
  const { GATE_APP, gateIdentityFromHeaders } = await import("./identity");
  expect(GATE_APP).toBe("hub-dogfood");

  const uid = "dogfood-user-2";
  const key = "dogfood-secret-key";
  const ts = Math.floor(Date.now() / 1000);
  // 签名用的是 hub（prod app），但当前实例是 hub-dogfood → 应该拒绝
  const hmac = createHmac("sha256", key)
    .update(`${uid}|hub|${ts}`)
    .digest("hex");
  const sig = `${ts}.${hmac}`;

  expect(gateIdentityFromHeaders({ uid, sig }, key, ts, 300)).toBeNull();
});
