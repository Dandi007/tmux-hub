#!/usr/bin/env bun
/**
 * eval/eval.ts
 *
 * 编排入口：run → judge → report（全自动）
 *
 * 用法：
 *   bun eval/eval.ts [--gold <path>] [--vocab <path>] [--limit <N>]
 *                    [--out <dir>]
 *                    [--fixtures <dir>]  ← fixture 模式，不发真网络请求
 */

import { existsSync, mkdirSync, readFileSync } from "fs";
import { runEval } from "./run";
import { runJudge } from "./judge";
import { generateReport } from "./report";

const args = Bun.argv.slice(2);
let goldPath = "eval/gold.jsonl";
let vocabPath = "eval/vocab.json";
let limit = 0;
let outDir = `runs/${Date.now()}`;
let fixturesDir = "";
let strategy: "vocab" | "history" | "both" = "vocab";
let historyPath = "";  // candidates json（[{cmd,count}] 或 [string]）作 B 的历史块

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--gold" && args[i + 1]) { goldPath = args[++i]!; }
  else if (args[i] === "--vocab" && args[i + 1]) { vocabPath = args[++i]!; }
  else if (args[i] === "--limit" && args[i + 1]) { limit = parseInt(args[++i]!, 10); }
  else if (args[i] === "--out" && args[i + 1]) { outDir = args[++i]!; }
  else if (args[i] === "--fixtures" && args[i + 1]) { fixturesDir = args[++i]!; }
  else if (args[i] === "--strategy" && args[i + 1]) { strategy = args[++i] as typeof strategy; }
  else if (args[i] === "--history" && args[i + 1]) { historyPath = args[++i]!; }
}

let historyCmds: string[] | undefined;
if (historyPath && existsSync(historyPath)) {
  const raw = JSON.parse(readFileSync(historyPath, "utf-8")) as Array<{ cmd: string } | string>;
  historyCmds = raw.map((x) => (typeof x === "string" ? x : x.cmd));
}

// fixture 模式：gold 从 fixtures/gold.jsonl 读取
if (fixturesDir && !existsSync(goldPath)) {
  const fixtureGold = `${fixturesDir}/gold.jsonl`;
  if (existsSync(fixtureGold)) goldPath = fixtureGold;
}
// 如果 --fixtures 指定了 gold.jsonl
if (fixturesDir && goldPath === "eval/gold.jsonl") {
  const fixtureGold = `${fixturesDir}/gold.jsonl`;
  if (existsSync(fixtureGold)) goldPath = fixtureGold;
}

mkdirSync(outDir, { recursive: true });

console.log(`[eval] gold=${goldPath} limit=${limit || "all"} out=${outDir} strategy=${strategy} history=${historyCmds?.length ?? 0} fixtures=${fixturesDir || "none"}`);

// Step 1: run
const producedPath = await runEval({
  goldPath,
  vocabPath: existsSync(vocabPath) ? vocabPath : undefined,
  outDir,
  limit: limit > 0 ? limit : undefined,
  fixturesDir: fixturesDir || undefined,
  strategy,
  historyCmds,
});
console.log(`[eval] produced: ${producedPath}`);

// Step 2: judge
const judgedPath = await runJudge({
  producedPath,
  outDir,
  fixturesDir: fixturesDir || undefined,
});
console.log(`[eval] judged: ${judgedPath}`);

// Step 3: report
const reportPath = await generateReport({ judgedPath, outDir });
console.log(`[eval] report: ${reportPath}`);

console.log("\nDone.");
