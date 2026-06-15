import { describe, test, expect } from "bun:test";
import { buildVariantMessages, buildSuggestMessages } from "../lib/prompts";
import type { VocabEntry } from "../lib/prompts";

const CTX = {
  text: "切换到千问模型",
  cwd: "/Users/uther/code",
  recentPane: "$ ",
};

const VOCAB: VocabEntry[] = [
  { name: "set_claude_ccswitch_qwen", purpose: "把 Claude Code 路由到通义千问" },
  { name: "svc", purpose: "本机服务管理唯一入口" },
  { name: "cc", purpose: "快速启动 Claude Code" },
];

describe("buildVariantMessages", () => {
  test("A 调用 buildSuggestMessages（线上真实 prompt）", () => {
    const messagesA = buildVariantMessages(CTX, "A");
    const reference = buildSuggestMessages(CTX);
    // A 变体必须与线上 buildSuggestMessages 完全一致
    expect(messagesA).toEqual(reference);
  });

  test("A 的 system 不含 vocab 字典块", () => {
    const messagesA = buildVariantMessages(CTX, "A", VOCAB);
    const systemA = messagesA.find((m) => m.role === "system")?.content ?? "";
    expect(systemA).not.toContain("用户的自定义命令");
    expect(systemA).not.toContain("set_claude_ccswitch_qwen");
  });

  test("B 的 system 含 vocab 字典块", () => {
    const messagesB = buildVariantMessages(CTX, "B", VOCAB);
    const systemB = messagesB.find((m) => m.role === "system")?.content ?? "";
    expect(systemB).toContain("用户的自定义命令");
    expect(systemB).toContain("set_claude_ccswitch_qwen");
    expect(systemB).toContain("svc");
  });

  test("B 与 A 的 user message 相同", () => {
    const messagesA = buildVariantMessages(CTX, "A");
    const messagesB = buildVariantMessages(CTX, "B", VOCAB);
    const userA = messagesA.find((m) => m.role === "user")?.content;
    const userB = messagesB.find((m) => m.role === "user")?.content;
    expect(userA).toBe(userB);
  });

  test("B 无 vocab 时退化为 A", () => {
    const messagesA = buildVariantMessages(CTX, "A");
    const messagesB = buildVariantMessages(CTX, "B", []);
    expect(messagesB).toEqual(messagesA);
  });
});
