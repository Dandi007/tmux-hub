import { describe, test, expect } from "bun:test";
import { aggregate, buildReport } from "../report";
import type { JudgedEntry } from "../judge";

const BASE: Omit<JudgedEntry, "id" | "verdict_a" | "rationale_a" | "verdict_b" | "rationale_b"> = {
  nl: "切换到千问",
  expected_cmd: "set_claude_ccswitch_qwen",
  tags: ["custom-fn", "model-switch"],
  notes: "",
  cwd: "/Users/uther/code",
  produced_a: "export QWEN_API_KEY=",
  produced_b: "set_claude_ccswitch_qwen",
};

function makeEntry(id: string, va: "correct" | "variant" | "wrong", vb: "correct" | "variant" | "wrong"): JudgedEntry {
  return {
    ...BASE,
    id,
    verdict_a: va,
    rationale_a: `A rationale for ${va}`,
    verdict_b: vb,
    rationale_b: `B rationale for ${vb}`,
  };
}

describe("aggregate", () => {
  test("全 correct", () => {
    const entries = [makeEntry("g001", "correct", "correct"), makeEntry("g002", "correct", "correct")];
    const s = aggregate(entries);
    expect(s.total).toBe(2);
    expect(s.strict_a).toBe(1);
    expect(s.strict_b).toBe(1);
    expect(s.delta_strict).toBe(0);
  });

  test("A wrong B correct → B 优于 A", () => {
    const entries = [
      makeEntry("g001", "wrong", "correct"),
      makeEntry("g002", "wrong", "correct"),
      makeEntry("g003", "correct", "correct"),
    ];
    const s = aggregate(entries);
    expect(s.strict_a).toBeCloseTo(1 / 3);
    expect(s.strict_b).toBeCloseTo(1);
    expect(s.delta_strict).toBeGreaterThan(0);
  });

  test("loose 包含 variant", () => {
    const entries = [
      makeEntry("g001", "variant", "correct"),
      makeEntry("g002", "wrong", "variant"),
    ];
    const s = aggregate(entries);
    expect(s.loose_a).toBe(0.5);  // 1 variant / 2
    expect(s.loose_b).toBe(1.0);  // 1 correct + 1 variant / 2
  });

  test("空 entries 不崩溃", () => {
    const s = aggregate([]);
    expect(s.total).toBe(0);
    expect(s.strict_a).toBe(0);
  });
});

describe("buildReport", () => {
  test("包含准确率（accuracy/准确率）关键词", () => {
    const entries = [
      makeEntry("g001", "correct", "correct"),
      makeEntry("g002", "wrong", "correct"),
    ];
    const report = buildReport(entries);
    expect(/准确率|accuracy/i.test(report)).toBe(true);
  });

  test("包含 A vs B strict/loose 数值", () => {
    const entries = [
      makeEntry("g001", "correct", "correct"),
      makeEntry("g002", "wrong", "correct"),
    ];
    const report = buildReport(entries);
    // A strict = 50%, B strict = 100%
    expect(report).toContain("50.0%");
    expect(report).toContain("100.0%");
  });

  test("失败条目出现在失败清单中", () => {
    const entries = [
      makeEntry("g001", "wrong", "correct"),
    ];
    const report = buildReport(entries);
    expect(report).toContain("g001");
    expect(report).toContain("失败清单");
  });

  test("按 tag 分组出现在报告中", () => {
    const entries = [
      makeEntry("g001", "wrong", "correct"),
      makeEntry("g002", "correct", "correct"),
    ];
    const report = buildReport(entries);
    expect(report).toContain("custom-fn");
    expect(report).toContain("model-switch");
  });

  test("含 Δ 符号（delta）", () => {
    const entries = [makeEntry("g001", "wrong", "correct")];
    const report = buildReport(entries);
    // delta_strict = 1.0 - 0.0 = +100%
    expect(report).toMatch(/\+100\.0%|-?\d+\.\d+%/);
  });
});
