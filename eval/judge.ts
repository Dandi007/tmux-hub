#!/usr/bin/env bun
/**
 * eval/judge.ts
 *
 * 每条 produced → Opus 判分 → runs/<ts>/judged.jsonl
 *
 * 用法：
 *   bun eval/judge.ts [--produced <path>] [--out <dir>]
 *                     [--fixtures <dir>]  ← fixture 模式，不发真网络请求
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { callOpus, type OpusConfig, type FetchLike } from "./lib/clients";
import { JUDGE_SYSTEM, buildJudgeUserMessage } from "./lib/prompts";
import type { ProducedEntry } from "./run";

export type Verdict = "correct" | "variant" | "wrong";

export type JudgedEntry = ProducedEntry & {
  verdict_a: Verdict;
  rationale_a: string;
  verdict_b: Verdict;
  rationale_b: string;
};

function parseJudgeResponse(text: string, entry: ProducedEntry): Pick<JudgedEntry, "verdict_a" | "rationale_a" | "verdict_b" | "rationale_b"> {
  const cleaned = text.replace(/^```[^\n]*\n?/, "").replace(/\n?```\s*$/, "").trim();
  try {
    const parsed = JSON.parse(cleaned) as Partial<JudgedEntry>;
    const toVerdict = (v: unknown): Verdict =>
      v === "correct" || v === "variant" || v === "wrong" ? v : "wrong";
    return {
      verdict_a: toVerdict(parsed.verdict_a),
      rationale_a: typeof parsed.rationale_a === "string" ? parsed.rationale_a : "",
      verdict_b: toVerdict(parsed.verdict_b),
      rationale_b: typeof parsed.rationale_b === "string" ? parsed.rationale_b : "",
    };
  } catch {
    return { verdict_a: "wrong", rationale_a: "parse error", verdict_b: "wrong", rationale_b: "parse error" };
  }
}

// fixture 模式：从 fixtures/judge-responses.json 读取预设响应
function makeFixtureOpusFetch(fixturesDir: string): FetchLike {
  const responsesPath = `${fixturesDir}/judge-responses.json`;
  const responses = existsSync(responsesPath)
    ? (JSON.parse(readFileSync(responsesPath, "utf-8")) as Record<string, string>)
    : {};
  const keys = Object.keys(responses);
  let idx = 0;

  return async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body)) as { messages?: Array<{ content: string }> };
    // user message contains nl + expected_cmd + produced_a + produced_b
    const userContent = body.messages?.map((m) => m.content).join(" ") ?? "";
    const matchKey = keys.find((k) => userContent.includes(k)) ?? keys[idx % Math.max(keys.length, 1)] ?? "";
    idx++;
    const responseText = responses[matchKey] ?? '{"verdict_a":"correct","rationale_a":"fixture","verdict_b":"correct","rationale_b":"fixture"}';

    const anthropicBody = {
      content: [{ type: "text", text: responseText }],
    };
    return new Response(JSON.stringify(anthropicBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

export async function runJudge(opts: {
  producedPath: string;
  outDir: string;
  fixturesDir?: string;
}): Promise<string> {
  const { producedPath, outDir, fixturesDir } = opts;

  const lines = readFileSync(producedPath, "utf-8")
    .trim()
    .split("\n")
    .filter((l) => l.trim() !== "");
  const entries = lines.map((l) => JSON.parse(l) as ProducedEntry);

  const opusCfg: OpusConfig = {
    endpoint: "http://127.0.0.1:15721/v1/messages",
    model: "lingzhi/claude-opus-4-8",
    maxTokens: 1024,
    timeoutMs: 30_000,
    fetchImpl: fixturesDir ? makeFixtureOpusFetch(fixturesDir) : undefined,
  };

  const judgedPath = `${outDir}/judged.jsonl`;
  writeFileSync(judgedPath, "", "utf-8");

  for (const entry of entries) {
    const userMsg = buildJudgeUserMessage({
      nl: entry.nl,
      expected_cmd: entry.expected_cmd,
      produced_a: entry.produced_a,
      produced_b: entry.produced_b,
    });

    const rawText = await callOpus(opusCfg, JUDGE_SYSTEM, [{ role: "user", content: userMsg }]);
    const scores = parseJudgeResponse(rawText, entry);

    const judged: JudgedEntry = { ...entry, ...scores };
    const file = Bun.file(judgedPath);
    const existing = await file.text();
    await Bun.write(judgedPath, existing + JSON.stringify(judged) + "\n");

    console.log(`[judge] ${entry.id}: A=${scores.verdict_a} B=${scores.verdict_b}`);
  }

  return judgedPath;
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  let producedPath = "";
  let outDir = "";
  let fixturesDir = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--produced" && args[i + 1]) { producedPath = args[++i]!; }
    else if (args[i] === "--out" && args[i + 1]) { outDir = args[++i]!; }
    else if (args[i] === "--fixtures" && args[i + 1]) { fixturesDir = args[++i]!; }
  }

  if (!producedPath || !outDir) {
    console.error("Usage: bun eval/judge.ts --produced <path> --out <dir> [--fixtures <dir>]");
    process.exit(1);
  }

  const judgedPath = await runJudge({
    producedPath,
    outDir,
    fixturesDir: fixturesDir || undefined,
  });

  console.log(`Judged: ${judgedPath}`);
}
