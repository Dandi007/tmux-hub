import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

// `TMUX_HUB_DEV_BIND_SECRET=1` makes unauthenticated `GET /system/auth-check`
// return the hub secret. In hub-sandbox the pane agent (and any host that can
// reach the mapped port) talks to the hub directly, bypassing the edge gate, so
// the switch must never reach the sandbox hub (issue #150).

test("sandbox env example does not enable DEV_BIND_SECRET", () => {
  const env = readFileSync("deploy/sandbox/sandbox.env.example", "utf8");
  expect(env).not.toMatch(/^\s*TMUX_HUB_DEV_BIND_SECRET\s*=/m);
});

test("sandbox entrypoint never forwards DEV_BIND_SECRET to the hub", () => {
  const sh = readFileSync("deploy/sandbox/entrypoint.sh", "utf8");
  const skip = sh.split("\n").find((l) => l.includes("case $v in"));
  expect(skip).toBeDefined();
  // The first case arm lists variables that are dropped; it must name the switch.
  const firstArm = skip!.slice(skip!.indexOf("case $v in") + "case $v in".length).split(")")[0]!;
  expect(firstArm.split("|").map((s) => s.trim())).toContain("TMUX_HUB_DEV_BIND_SECRET");
});
