import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { InputRouter, HubError } from "../../src/server/input-router";

test("binary input preserves every byte across chunks before later text", async () => {
  const dir = mkdtempSync("/tmp/input-binary-");
  const socket = `binary-${process.pid}-${Date.now()}`;
  const name = "binary-owned", file = `${dir}/received`;
  const tmux = (args: string[]) => Bun.spawnSync(["tmux", "-f", "/dev/null", "-L", socket, ...args]);
  writeFileSync(`${dir}/app.sh`, `stty raw -echo; touch ${dir}/ready; dd bs=1 of=${file} 2>/dev/null`);
  try {
    expect(tmux(["new-session", "-d", "-s", name, `sh ${dir}/app.sh`]).exitCode).toBe(0);
    const wait = async (fn: () => boolean) => { const end = Date.now() + 3000; while (!fn()) { if (Date.now() > end) throw new Error("byte consumer timeout"); await Bun.sleep(5); } };
    await wait(() => existsSync(`${dir}/ready`));
    const router = new InputRouter(async args => { const p = tmux(args); return { stdout: p.stdout.toString(), stderr: p.stderr.toString(), code: p.exitCode }; });
    const payload = Buffer.from(Array.from({ length: 2049 }, (_, i) => i % 256));
    await Promise.all([
      router.send(name, { kind: "binary", data: payload.toString("latin1") }),
      router.send(name, { kind: "keys", literal: "END" }),
    ]);
    const expected = Buffer.concat([payload, Buffer.from("END")]);
    await wait(() => existsSync(file) && readFileSync(file).length >= expected.length);
    expect(readFileSync(file)).toEqual(expected);
  } finally { tmux(["kill-server"]); rmSync(dir, { recursive: true, force: true }); }
});

test("invalid non-byte data is rejected before any partial input is sent", async () => {
  let calls = 0;
  const router = new InputRouter(async () => { calls++; return { stdout: "", stderr: "", code: 0 }; });
  await expect(router.send("binary-owned", { kind: "binary", data: "A\u0100" })).rejects.toBeInstanceOf(HubError);
  expect(calls).toBe(0);
});
