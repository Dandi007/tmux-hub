import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Private log dir (LOG_DIR is captured at import time) and managed db.
const TMP = mkdtempSync(join(tmpdir(), "tht-recreate-"));
process.env.TMUX_HUB_LOG_DIR = TMP;

import { tmuxTest, tmuxTestKillServer } from "../helpers/tmux-test";
import { BroadcasterRegistry } from "../../src/server/output-broadcaster";
import { SessionRegistry, listSessions } from "../../src/server/session-registry";
import { ManagedSessionDb } from "../../src/server/managed-db";

afterAll(async () => {
  await tmuxTestKillServer();
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
});

const S = "user-recreate-" + Date.now().toString().slice(-8);
const ticker = (tag: string) => ["sh", "-c", `while true; do echo ${tag}; sleep 0.05; done`];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The rsi driver kills a session and launches a new one under the same name
// within one registry poll (2026-10-19, dogfood): the new pane had no
// pipe-pane, so every browser attach got the snapshot and then a frozen screen.
test("a session killed and recreated under the same name gets a live broadcaster", async () => {
  // Keeper: killing the only session would take the test server down with it.
  await tmuxTest(["new-session", "-d", "-s", S + "-keeper", "sleep", "3600"]);
  await tmuxTest(["new-session", "-d", "-s", S, ...ticker("OLD")]);
  const db = new ManagedSessionDb(join(TMP, "m.db"));
  db.add(S);
  const registry = new SessionRegistry(db, () => listSessions(tmuxTest));
  const broadcasters = new BroadcasterRegistry(tmuxTest, true);
  // main.ts wiring: removed → stop, created → prime.
  registry.subscribe(async (e) => {
    if (e.event === "session_created") await broadcasters.get(e.payload.name);
    else if (e.event === "session_removed") await broadcasters.stop(e.payload.name, { deleteLog: true });
  });
  await registry.pollNow();
  const old = await broadcasters.get(S);
  let oldStopped = false;
  old.onEvent((ev) => { if (ev.kind === "stopped") oldStopped = true; });

  await tmuxTest(["kill-session", "-t", S]);
  await tmuxTest(["new-session", "-d", "-s", S, ...ticker("NEW")]);
  await registry.pollNow();
  await sleep(300);

  expect(oldStopped).toBe(true);
  expect((await tmuxTest(["display", "-p", "-t", `${S}:0.0`, "#{pane_pipe}"])).stdout).toBe("1");
  const got: Uint8Array[] = [];
  (await broadcasters.get(S)).attach((c) => { got.push(c); });
  await sleep(500);
  expect(Buffer.concat(got).toString()).toContain("NEW");

  await broadcasters.stopAll();
  db.close();
}, 10_000);

// A get() whose start fails (session not there yet / already gone) must not
// leave the half-built broadcaster cached: the next get() for that name would
// return it, with no pipe-pane, and the session would never stream.
test("a failed start is not cached; the next get() starts a working broadcaster", async () => {
  const T = S + "-late";
  const broadcasters = new BroadcasterRegistry(tmuxTest, true);
  await expect(broadcasters.get(T)).rejects.toThrow(/pipe-pane failed/);
  expect(broadcasters.size()).toBe(0);

  await tmuxTest(["new-session", "-d", "-s", T, ...ticker("LATE")]);
  const b = await broadcasters.get(T);
  expect((await tmuxTest(["display", "-p", "-t", `${T}:0.0`, "#{pane_pipe}"])).stdout).toBe("1");
  const got: Uint8Array[] = [];
  b.attach((c) => { got.push(c); });
  await sleep(500);
  expect(Buffer.concat(got).toString()).toContain("LATE");
  await broadcasters.stopAll();
}, 10_000);
