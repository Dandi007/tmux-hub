import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSuggestRoutes } from "../../src/server/suggest-routes";
import type { ChatMessage } from "../../src/server/suggest/prompt";
import { HISTORY_HEADER, _resetCacheForTest } from "../../src/server/suggest/history";

// 临时 history 文件路径（每个 history 测试用独立路径）
const TMP_DIR = tmpdir();

beforeEach(() => {
  _resetCacheForTest();
});

afterEach(() => {
  _resetCacheForTest();
});

// 注入 fake tmuxRun：按 args 返回 pane_current_command / path / capture-pane。
function fakeTmux(paneCmd: string) {
  return async (args: string[]) => {
    const fmt = args.find((a) => a.startsWith("#{")) ?? "";
    if (fmt.includes("pane_current_command")) return { stdout: paneCmd, stderr: "", code: 0 };
    if (fmt.includes("pane_current_path")) return { stdout: "/repo", stderr: "", code: 0 };
    if (args[0] === "capture-pane") return { stdout: "$ git status", stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  };
}
const echoModel = async (_msgs: ChatMessage[]) => "git push -u origin HEAD";
function app(deps: Partial<Parameters<typeof buildSuggestRoutes>[0]> & { paneCmd?: string } = {}) {
  const a = new Hono();
  a.route("/", buildSuggestRoutes({
    enabled: deps.enabled ?? true,
    captureLines: 40,
    callModel: deps.callModel ?? echoModel,
    tmuxRun: deps.tmuxRun ?? fakeTmux(deps.paneCmd ?? "zsh"),
  }));
  return a;
}
const post = (a: Hono, p: string, body: unknown) =>
  a.fetch(new Request(`http://x${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const get = (a: Hono, p: string) => a.fetch(new Request(`http://x${p}`));

describe("suggest routes", () => {
  test("shell pane → translated:true + command", async () => {
    const r = await post(app({ paneCmd: "zsh" }), "/sessions/s1/suggest", { text: "把分支推上去" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ translated: true, command: "git push -u origin HEAD" });
  });
  test("非 shell pane → translated:false（不调模型）", async () => {
    let called = false;
    const r = await post(app({ paneCmd: "node", callModel: async () => { called = true; return "x"; } }),
      "/sessions/s1/suggest", { text: "随便" });
    expect(await r.json()).toEqual({ translated: false });
    expect(called).toBe(false);
  });
  test("flag 关 → translated:false", async () => {
    const r = await post(app({ enabled: false }), "/sessions/s1/suggest", { text: "x" });
    expect(await r.json()).toEqual({ translated: false });
  });
  test("空 text → 400", async () => {
    const r = await post(app(), "/sessions/s1/suggest", { text: "  " });
    expect(r.status).toBe(400);
  });
  test("坏 session 名 → 400", async () => {
    const r = await post(app(), "/sessions/Bad.Name/suggest", { text: "x" });
    expect(r.status).toBe(400);
  });
  test("模型抛错 → 502", async () => {
    const r = await post(app({ callModel: async () => { throw new Error("boom"); } }),
      "/sessions/s1/suggest", { text: "x" });
    expect(r.status).toBe(502);
  });
  test("pane-mode GET：shell / other / 关", async () => {
    expect(await (await get(app({ paneCmd: "zsh" }), "/sessions/s1/pane-mode")).json()).toMatchObject({ mode: "shell" });
    expect(await (await get(app({ paneCmd: "claude" }), "/sessions/s1/pane-mode")).json()).toMatchObject({ mode: "other" });
    expect(await (await get(app({ enabled: false }), "/sessions/s1/pane-mode")).json()).toMatchObject({ mode: "other", enabled: false });
  });

  // === 历史注入集成测试 ===

  test("history flag 开 + fake history 文件 → worker messages system 含 HISTORY_HEADER", async () => {
    // 写一个 fake zsh history 文件
    const histPath = join(TMP_DIR, `suggest-test-history-${Date.now()}.txt`);
    writeFileSync(histPath, [
      ": 1700000000:0;git status",
      ": 1700000001:0;git push",
      ": 1700000002:0;git status",
    ].join("\n"), "utf8");

    let capturedMsgs: ChatMessage[] = [];
    const captureModel = async (msgs: ChatMessage[]) => {
      capturedMsgs = msgs;
      return "git status";
    };

    const a = new Hono();
    a.route("/", buildSuggestRoutes({
      enabled: true,
      captureLines: 40,
      callModel: captureModel,
      tmuxRun: fakeTmux("zsh"),
      history: { enabled: true, path: histPath, topN: 80 },
    }));

    const r = await post(a, "/sessions/s1/suggest", { text: "看看 git 状态" });
    expect(r.status).toBe(200);
    expect(capturedMsgs.length).toBeGreaterThan(0);
    const system = capturedMsgs[0]!.content;
    expect(system).toContain(HISTORY_HEADER);
    expect(system).toContain("git status");

    unlinkSync(histPath);
  });

  test("history flag 关 → system 不含 HISTORY_HEADER", async () => {
    const histPath = join(TMP_DIR, `suggest-test-history-off-${Date.now()}.txt`);
    writeFileSync(histPath, ": 1700000000:0;git status\n", "utf8");

    let capturedMsgs: ChatMessage[] = [];
    const captureModel = async (msgs: ChatMessage[]) => {
      capturedMsgs = msgs;
      return "git status";
    };

    const a = new Hono();
    a.route("/", buildSuggestRoutes({
      enabled: true,
      captureLines: 40,
      callModel: captureModel,
      tmuxRun: fakeTmux("zsh"),
      history: { enabled: false, path: histPath, topN: 80 },
    }));

    const r = await post(a, "/sessions/s1/suggest", { text: "看看 git 状态" });
    expect(r.status).toBe(200);
    const system = capturedMsgs[0]!.content;
    expect(system).not.toContain(HISTORY_HEADER);

    unlinkSync(histPath);
  });

  test("history 读失败（文件不存在）→ suggest 仍正常返回，不含 HISTORY_HEADER", async () => {
    const nonExistPath = join(TMP_DIR, `no-such-history-${Date.now()}.txt`);

    let capturedMsgs: ChatMessage[] = [];
    const captureModel = async (msgs: ChatMessage[]) => {
      capturedMsgs = msgs;
      return "git log";
    };

    const a = new Hono();
    a.route("/", buildSuggestRoutes({
      enabled: true,
      captureLines: 40,
      callModel: captureModel,
      tmuxRun: fakeTmux("zsh"),
      history: { enabled: true, path: nonExistPath, topN: 80 },
    }));

    const r = await post(a, "/sessions/s1/suggest", { text: "看看日志" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ translated: true });
    const system = capturedMsgs[0]!.content;
    expect(system).not.toContain(HISTORY_HEADER);
  });
});
