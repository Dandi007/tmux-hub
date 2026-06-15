#!/usr/bin/env bun
/**
 * eval/report.ts
 *
 * 聚合 judged.jsonl → runs/<ts>/report.md
 *
 * 报告结构：
 *   - BLUF：A vs B strict/loose 准确率 + Δ + 结论
 *   - 按 tag 分组准确率
 *   - 失败清单（wrong 条目）
 *   - 失败类型直方图
 */

import { readFileSync, writeFileSync } from "fs";
import type { JudgedEntry, Verdict } from "./judge";

export type AggregateStats = {
  total: number;
  correct_a: number;
  variant_a: number;
  wrong_a: number;
  correct_b: number;
  variant_b: number;
  wrong_b: number;
  strict_a: number;  // correct_a / total
  loose_a: number;   // (correct_a + variant_a) / total
  strict_b: number;
  loose_b: number;
  delta_strict: number;
  delta_loose: number;
};

export function aggregate(entries: JudgedEntry[]): AggregateStats {
  const total = entries.length;
  if (total === 0) {
    return { total: 0, correct_a: 0, variant_a: 0, wrong_a: 0, correct_b: 0, variant_b: 0, wrong_b: 0, strict_a: 0, loose_a: 0, strict_b: 0, loose_b: 0, delta_strict: 0, delta_loose: 0 };
  }
  let correct_a = 0, variant_a = 0, wrong_a = 0;
  let correct_b = 0, variant_b = 0, wrong_b = 0;
  for (const e of entries) {
    if (e.verdict_a === "correct") correct_a++;
    else if (e.verdict_a === "variant") variant_a++;
    else wrong_a++;
    if (e.verdict_b === "correct") correct_b++;
    else if (e.verdict_b === "variant") variant_b++;
    else wrong_b++;
  }
  const pct = (n: number) => n / total;
  const strict_a = pct(correct_a);
  const loose_a = pct(correct_a + variant_a);
  const strict_b = pct(correct_b);
  const loose_b = pct(correct_b + variant_b);
  return {
    total, correct_a, variant_a, wrong_a, correct_b, variant_b, wrong_b,
    strict_a, loose_a, strict_b, loose_b,
    delta_strict: strict_b - strict_a,
    delta_loose: loose_b - loose_a,
  };
}

function pctStr(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function deltaStr(v: number): string {
  const s = (v * 100).toFixed(1);
  return v >= 0 ? `+${s}%` : `${s}%`;
}

export function buildReport(entries: JudgedEntry[]): string {
  const stats = aggregate(entries);
  const lines: string[] = [];

  // BLUF
  lines.push("# Suggest NL→命令 准确率 A/B 评估报告");
  lines.push("");
  lines.push("## BLUF");
  lines.push("");
  lines.push(`| 指标 | A（baseline）| B（+上下文增强）| Δ |`);
  lines.push(`|------|-------------|-----------|---|`);
  lines.push(`| strict 准确率 | ${pctStr(stats.strict_a)} | ${pctStr(stats.strict_b)} | ${deltaStr(stats.delta_strict)} |`);
  lines.push(`| loose 准确率 | ${pctStr(stats.loose_a)} | ${pctStr(stats.loose_b)} | ${deltaStr(stats.delta_loose)} |`);
  lines.push(`| 总用例数 | ${stats.total} | ${stats.total} | — |`);
  lines.push("");

  if (stats.delta_strict > 0.05) {
    lines.push(`**结论：B（上下文增强）显著提升 strict 准确率 ${deltaStr(stats.delta_strict)}。注意按策略与失败分类综合判断（如 history 注入对历史内命令是复用而非泛化）。**`);
  } else if (stats.delta_strict > 0) {
    lines.push(`**结论：B 有小幅提升（${deltaStr(stats.delta_strict)}），需结合 loose 指标综合判断。**`);
  } else {
    lines.push(`**结论：B 与 A 准确率相近或更低（${deltaStr(stats.delta_strict)}），词汇注入效果不显著。**`);
  }
  lines.push("");

  // 按 tag 分组
  lines.push("## 按 Tag 分组准确率");
  lines.push("");
  lines.push(`| Tag | 数量 | A strict | B strict | Δ strict |`);
  lines.push(`|-----|------|----------|----------|----------|`);

  const tagMap = new Map<string, JudgedEntry[]>();
  for (const e of entries) {
    for (const tag of e.tags) {
      if (!tagMap.has(tag)) tagMap.set(tag, []);
      tagMap.get(tag)!.push(e);
    }
  }

  for (const [tag, tagEntries] of Array.from(tagMap.entries()).sort()) {
    const s = aggregate(tagEntries);
    lines.push(`| ${tag} | ${s.total} | ${pctStr(s.strict_a)} | ${pctStr(s.strict_b)} | ${deltaStr(s.delta_strict)} |`);
  }
  lines.push("");

  // 失败清单（wrong 条目）
  const wrongEntries = entries.filter((e) => e.verdict_a === "wrong" || e.verdict_b === "wrong");
  lines.push("## 失败清单");
  lines.push("");
  if (wrongEntries.length === 0) {
    lines.push("无失败条目。");
  } else {
    for (const e of wrongEntries) {
      lines.push(`### ${e.id}`);
      lines.push(`- **nl**: ${e.nl}`);
      lines.push(`- **expected**: \`${e.expected_cmd}\``);
      lines.push(`- **produced A**: \`${e.produced_a}\` → ${e.verdict_a}: ${e.rationale_a}`);
      lines.push(`- **produced B**: \`${e.produced_b}\` → ${e.verdict_b}: ${e.rationale_b}`);
      lines.push("");
    }
  }

  // 失败类型直方图（基于 rationale 关键词）
  lines.push("## 失败类型直方图");
  lines.push("");
  const failureTypes: Record<string, number> = {
    "未知自定义命令": 0,
    "选错工具": 0,
    "flag 错": 0,
    "占位": 0,
    "幻觉": 0,
    "其他": 0,
  };

  const wrongAll = entries.filter((e) => e.verdict_a === "wrong" || e.verdict_b === "wrong");
  for (const e of wrongAll) {
    const rationale = (e.rationale_a + " " + e.rationale_b).toLowerCase();
    if (/自定义|custom|不知道/.test(rationale)) failureTypes["未知自定义命令"]!++;
    else if (/占位|placeholder/.test(rationale)) failureTypes["占位"]!++;
    else if (/幻觉|hallucin/.test(rationale)) failureTypes["幻觉"]!++;
    else if (/flag|参数|option/.test(rationale)) failureTypes["flag 错"]!++;
    else if (/工具|tool|命令/.test(rationale)) failureTypes["选错工具"]!++;
    else failureTypes["其他"]!++;
  }

  for (const [type, count] of Object.entries(failureTypes)) {
    if (count > 0) {
      const bar = "█".repeat(count);
      lines.push(`- **${type}**: ${count} ${bar}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

export async function generateReport(opts: {
  judgedPath: string;
  outDir: string;
}): Promise<string> {
  const { judgedPath, outDir } = opts;

  const lines = readFileSync(judgedPath, "utf-8")
    .trim()
    .split("\n")
    .filter((l) => l.trim() !== "");
  const entries = lines.map((l) => JSON.parse(l) as JudgedEntry);

  const report = buildReport(entries);
  const reportPath = `${outDir}/report.md`;
  writeFileSync(reportPath, report, "utf-8");

  return reportPath;
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  let judgedPath = "";
  let outDir = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--judged" && args[i + 1]) { judgedPath = args[++i]!; }
    else if (args[i] === "--out" && args[i + 1]) { outDir = args[++i]!; }
  }

  if (!judgedPath || !outDir) {
    console.error("Usage: bun eval/report.ts --judged <path> --out <dir>");
    process.exit(1);
  }

  const reportPath = await generateReport({ judgedPath, outDir });
  console.log(`Report: ${reportPath}`);
}
