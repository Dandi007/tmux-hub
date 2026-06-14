import { describe, test, expect } from "bun:test";
import { makeCcSwitchCaller } from "../../src/server/suggest/cc-switch-client";

function okResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

describe("makeCcSwitchCaller", () => {
  test("发 model+messages，取回 content", async () => {
    let seen: any = null;
    const call = makeCcSwitchCaller({
      endpoint: "http://x/v1/chat/completions", model: "m", timeoutMs: 1000,
      fetchImpl: async (_url, init) => { seen = JSON.parse(String((init as RequestInit).body)); return okResponse("git push"); },
    });
    const out = await call([{ role: "user", content: "hi" }]);
    expect(out).toBe("git push");
    expect(seen.model).toBe("m");
    expect(seen.messages[0].content).toBe("hi");
  });
  test("非 2xx → 抛错", async () => {
    const call = makeCcSwitchCaller({
      endpoint: "http://x", model: "m", timeoutMs: 1000,
      fetchImpl: async () => new Response("nope", { status: 500 }),
    });
    await expect(call([{ role: "user", content: "hi" }])).rejects.toThrow();
  });
  test("空 content → 抛错", async () => {
    const call = makeCcSwitchCaller({
      endpoint: "http://x", model: "m", timeoutMs: 1000,
      fetchImpl: async () => okResponse("   "),
    });
    await expect(call([{ role: "user", content: "hi" }])).rejects.toThrow();
  });
});
