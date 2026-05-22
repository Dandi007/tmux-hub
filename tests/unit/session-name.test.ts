import { describe, test, expect } from "bun:test";
import { isGrammarOk, assertGrammar, GrammarError } from "../../src/shared/session-name";

describe("session name grammar (relaxed)", () => {
  test("accepts template-form generated names", () => {
    expect(isGrammarOk("codex-20260521161200")).toBe(true);
    expect(isGrammarOk("claude-20260101000000")).toBe(true);
  });

  test("accepts user- prefixed names", () => {
    expect(isGrammarOk("user-my-work")).toBe(true);
    expect(isGrammarOk("user-abc_def-123")).toBe(true);
  });

  test("accepts real-world names", () => {
    expect(isGrammarOk("37")).toBe(true);
    expect(isGrammarOk("tmux-hub-svc")).toBe(true);
    expect(isGrammarOk("MyWork")).toBe(true);
    expect(isGrammarOk("my_work")).toBe(true);
    expect(isGrammarOk("a")).toBe(true);
    expect(isGrammarOk("A_b-C_2026")).toBe(true);
  });

  test("rejects empty / 65+ chars", () => {
    expect(isGrammarOk("")).toBe(false);
    expect(isGrammarOk("a".repeat(65))).toBe(false);
    expect(isGrammarOk("a".repeat(64))).toBe(true);
  });

  test("rejects dangerous chars: colon dot slash space tab newline", () => {
    expect(isGrammarOk("with:colon")).toBe(false);
    expect(isGrammarOk("with.dot")).toBe(false);
    expect(isGrammarOk("with/slash")).toBe(false);
    expect(isGrammarOk("with space")).toBe(false);
    expect(isGrammarOk("with\ttab")).toBe(false);
    expect(isGrammarOk("with\nnewline")).toBe(false);
  });

  test("assertGrammar throws GrammarError for bad names, doesn't throw for good", () => {
    expect(() => assertGrammar("with:colon")).toThrow(GrammarError);
    expect(() => assertGrammar("37")).not.toThrow();
    expect(() => assertGrammar("tmux-hub-svc")).not.toThrow();
  });
});
