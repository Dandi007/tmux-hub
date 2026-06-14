import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getPaneMode, requestSuggestion } from "../../src/web/mobile/suggest-client";

const realFetch = globalThis.fetch;
let lastUrl = "";
function stub(status: number, json: unknown) {
  globalThis.fetch = (async (url: any) => {
    lastUrl = String(url);
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
beforeEach(() => { (globalThis as any).sessionStorage = { getItem: () => "sek", setItem: () => {}, removeItem: () => {} }; });
afterEach(() => { globalThis.fetch = realFetch; });

describe("suggest-client", () => {
  test("getPaneMode shell", async () => {
    stub(200, { mode: "shell", enabled: true });
    expect(await getPaneMode("s1")).toEqual({ mode: "shell", enabled: true });
    expect(lastUrl).toContain("/sessions/s1/pane-mode");
  });
  test("getPaneMode 失败 → other/disabled（不抛）", async () => {
    stub(500, {});
    expect(await getPaneMode("s1")).toEqual({ mode: "other", enabled: false });
  });
  test("requestSuggestion translated:true", async () => {
    stub(200, { translated: true, command: "ls -la" });
    expect(await requestSuggestion("s1", "列出文件", new AbortController().signal))
      .toEqual({ translated: true, command: "ls -la" });
  });
  test("requestSuggestion 非 2xx → error", async () => {
    stub(502, { error: "x" });
    const out = await requestSuggestion("s1", "x", new AbortController().signal);
    expect("error" in out).toBe(true);
  });
});
