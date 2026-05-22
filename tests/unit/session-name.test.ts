import { describe, test, expect } from "bun:test";
import { isGrammarOk, assertGrammar, GrammarError } from "../../src/shared/session-name";

describe("isGrammarOk — template form", () => {
  test("accepts codex-20260521161200", () => {
    expect(isGrammarOk("codex-20260521161200")).toBe(true);
  });

  test("accepts claude-20260101000000", () => {
    expect(isGrammarOk("claude-20260101000000")).toBe(true);
  });

  test("accepts single-char id a-20260521161200", () => {
    expect(isGrammarOk("a-20260521161200")).toBe(true);
  });

  test("accepts max-length 16-char id", () => {
    // "a1234567890123" = 14 chars; still within 16 cap
    expect(isGrammarOk("a1234567890123-20260521161200")).toBe(true);
  });

  test("accepts exactly 16-char id at boundary", () => {
    // "a123456789012345" = 16 chars (1 + 15)
    expect(isGrammarOk("a123456789012345-20260521161200")).toBe(true);
  });
});

describe("isGrammarOk — user form", () => {
  test("accepts user-my-work", () => {
    expect(isGrammarOk("user-my-work")).toBe(true);
  });

  test("accepts user-a (min suffix)", () => {
    expect(isGrammarOk("user-a")).toBe(true);
  });

  test("accepts user-abc_def-123 with underscore and digits", () => {
    expect(isGrammarOk("user-abc_def-123")).toBe(true);
  });
});

describe("isGrammarOk — template negatives", () => {
  test("rejects uppercase in id", () => {
    expect(isGrammarOk("Codex-20260521161200")).toBe(false);
  });

  test("rejects dot in id", () => {
    expect(isGrammarOk("cod.ex-20260521161200")).toBe(false);
  });

  test("rejects missing timestamp (no dash)", () => {
    expect(isGrammarOk("codex")).toBe(false);
  });

  test("rejects empty timestamp", () => {
    expect(isGrammarOk("codex-")).toBe(false);
  });

  test("rejects short timestamp", () => {
    expect(isGrammarOk("codex-2026")).toBe(false);
  });

  test("rejects id longer than 16 chars", () => {
    // "a12345678901234567" = 18 chars
    expect(isGrammarOk("a12345678901234567-20260521161200")).toBe(false);
  });
});

describe("isGrammarOk — user negatives", () => {
  test("rejects uppercase user suffix", () => {
    expect(isGrammarOk("user-MyWork")).toBe(false);
  });

  test("rejects dot in user suffix", () => {
    expect(isGrammarOk("user-foo.bar")).toBe(false);
  });

  test("rejects empty user suffix", () => {
    expect(isGrammarOk("user-")).toBe(false);
  });
});

describe("isGrammarOk — edge cases", () => {
  test("rejects empty string", () => {
    expect(isGrammarOk("")).toBe(false);
  });

  test("rejects colon separator", () => {
    expect(isGrammarOk("codex:20260521161200")).toBe(false);
  });

  test("rejects space separator", () => {
    expect(isGrammarOk("codex 20260521161200")).toBe(false);
  });
});

describe("assertGrammar", () => {
  test("does not throw for valid template name", () => {
    expect(() => assertGrammar("codex-20260521161200")).not.toThrow();
  });

  test("does not throw for valid user name", () => {
    expect(() => assertGrammar("user-my-work")).not.toThrow();
  });

  test("throws GrammarError for invalid name", () => {
    expect(() => assertGrammar("Bad-Name")).toThrow(GrammarError);
  });

  test("GrammarError carries sessionName", () => {
    try {
      assertGrammar("bad name");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GrammarError);
      expect((err as GrammarError).sessionName).toBe("bad name");
      expect((err as GrammarError).name).toBe("GrammarError");
    }
  });
});
