import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { listSessions, SessionRegistry, REMOVAL_CONFIRM_POLLS } from "../../src/server/session-registry";
import { ManagedSessionDb } from "../../src/server/managed-db";
import type { TmuxResult } from "../../src/server/tmux-cmd";

const TMP = mkdtempSync("/tmp/tht-rpg-");

function dbPath() {
  return join(TMP, `test-${Math.random().toString(36).slice(2, 8)}.db`);
}

afterAll(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
});

const fakeTmux = (r: TmuxResult) => async (_args: string[]): Promise<TmuxResult> => r;

describe("listSessions error semantics", () => {
  test("'no server running' → null（探测不确定，不能当成空列表）", async () => {
    const result = await listSessions(
      fakeTmux({ stdout: "", stderr: "no server running on /tmp/tmux-1000/default", code: 1 }),
    );
    expect(result).toBeNull();
  });

  test("'no sessions' → []（server 在，真的 0 个 session）", async () => {
    const result = await listSessions(
      fakeTmux({ stdout: "", stderr: "no sessions", code: 1 }),
    );
    expect(result).toEqual([]);
  });

  test("其它错误 → null", async () => {
    const result = await listSessions(
      fakeTmux({ stdout: "", stderr: "error connecting to /tmp/tmux-1000/default (Permission denied)", code: 1 }),
    );
    expect(result).toBeNull();
  });
});

// Registry 的注入 seam 是 lister（poll 级，#90 引入）；这里组合
// listSessions + fake tmux runner，让 poll 走过 listSessions 的真实语义映射，
// 同时覆盖 #90 的去抖与本 fix 的探测语义。
const listerWith = (r: TmuxResult) => () => listSessions(fakeTmux(r));

describe("SessionRegistry.poll prune guard", () => {
  test("'no server running' 期间 poll 永不 prune managed_sessions（历史事故：整表误清）", async () => {
    const db = new ManagedSessionDb(dbPath());
    db.add("hub-a");
    db.add("hub-b");

    const registry = new SessionRegistry(
      db,
      listerWith({ stdout: "", stderr: "no server running on /tmp/tmux-1000/default", code: 1 }),
    );
    // 连续 poll 超过去抖阈值也不能 prune——探测不确定与"确认缺失"是两回事。
    for (let i = 0; i < REMOVAL_CONFIRM_POLLS + 1; i++) await registry.pollNow();

    expect(registry.isServerReachable()).toBe(false);
    expect(db.all()).toEqual(new Set(["hub-a", "hub-b"]));
    db.close();
  });

  test("server 在但 0 session（'no sessions'）→ 去抖确认后正常 prune 已死注册项", async () => {
    const db = new ManagedSessionDb(dbPath());
    db.add("hub-dead");

    const registry = new SessionRegistry(
      db,
      listerWith({ stdout: "", stderr: "no sessions", code: 1 }),
    );
    // 去抖窗口内不 prune（单次 miss 可能是抖动）……
    await registry.pollNow();
    expect(registry.isServerReachable()).toBe(true);
    expect(db.all()).toEqual(new Set(["hub-dead"]));
    // ……连续 REMOVAL_CONFIRM_POLLS 次确认后才 prune。
    for (let i = 1; i < REMOVAL_CONFIRM_POLLS; i++) await registry.pollNow();
    expect(db.all()).toEqual(new Set());
    db.close();
  });
});
