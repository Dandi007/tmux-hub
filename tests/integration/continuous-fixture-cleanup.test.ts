import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { stopOwnedGenerator } from "../helpers/stop-owned-generator";
const socket = `continuous-cleanup-${process.pid}-${Date.now()}`;
const roots: string[] = [];
const tmux = (...args: string[]) => Bun.spawnSync(["tmux", "-L", socket, ...args]);
const names = () => new TextDecoder().decode(tmux("list-sessions", "-F", "#{session_name}").stdout).trim().split("\n");
afterAll(() => { tmux("kill-server"); for (const p of roots) rmSync(p, { recursive: true, force: true }); });
const until = async (fn: () => boolean) => { const end = Date.now() + 2000; while (!fn()) { if (Date.now() > end) throw new Error("timeout"); await Bun.sleep(5); } };
const controls = { listSessions: names, killSession: (name: string) => { expect(tmux("kill-session", "-t", name).exitCode).toBe(0); } };

test("failed check waits for the generator's stop acknowledgement before deleting its directory", async () => {
  const dir = mkdtempSync("/tmp/continuous-ack-"); roots.push(dir);
  const name = "owned-ack";
  writeFileSync(`${dir}/app.sh`, `touch ${dir}/ready; while [ ! -f ${dir}/stop ]; do sleep 0.05; done; touch ${dir}/done`);
  expect(tmux("new-session", "-d", "-s", name, `sh ${dir}/app.sh`).exitCode).toBe(0);
  await until(() => existsSync(`${dir}/ready`));
  let failed = false, cleanup;
  try { throw new Error("intentional failed screen check"); }
  catch { failed = true; }
  finally { cleanup = await stopOwnedGenerator(dir, name, controls); }
  expect(failed).toBe(true);
  expect(cleanup).toEqual({ acknowledged: true, forced: false });
  expect(existsSync(dir)).toBe(false);
  await until(() => !names().includes(name));
});

test("a generator ignoring stop is terminated without touching another private session", async () => {
  const dir = mkdtempSync("/tmp/continuous-force-"); roots.push(dir);
  expect(tmux("new-session", "-d", "-s", "keeper", "sleep 30").exitCode).toBe(0);
  expect(tmux("new-session", "-d", "-s", "owned-stuck", "sleep 30").exitCode).toBe(0);
  const cleanup = await stopOwnedGenerator(dir, "owned-stuck", controls, 50);
  expect(cleanup).toEqual({ acknowledged: false, forced: true });
  expect(names()).not.toContain("owned-stuck");
  expect(names()).toContain("keeper");
  expect(existsSync(dir)).toBe(false);
});
