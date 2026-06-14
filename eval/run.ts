#!/usr/bin/env bun
/**
 * eval/run.ts
 *
 * gold × {A,B} → worker → runs/<ts>/produced.jsonl
 * 纯文本比对，绝不 exec 任何生成命令。
 *
 * 用法：
 *   bun eval/run.ts [--gold <path>] [--vocab <path>] [--out <dir>] [--limit <N>]
 *                   [--fixtures <dir>]  ← fixture 模式：注入假 fetch，不发真网络请求
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { callWorker, type WorkerConfig, type FetchLike } from "./lib/clients";
import { buildVariantMessages, type VocabEntry } from "./lib/prompts";
import type { GoldEntry } from "./gen-gold";

export type ProducedEntry = {
  id: string;
  nl: string;
  expected_cmd: string;
  tags: string[];
  notes: string;
  cwd: string;
  produced_a: string;
  produced_b: string;
};

// 极简 pane（A/B 共用占位）
const PLACEHOLDER_PANE = "$ ";
const DEFAULT_CWD = "/Users/uther/code";

// 读取 gold.jsonl → GoldEntry[]
export function loadGold(path: string): GoldEntry[] {
  const lines = readFileSync(path, "utf-8").trim().split("\n").filter((l) => l.trim() !== "");
  return lines.map((l) => JSON.parse(l) as GoldEntry);
}

// fixture 模式：从 fixtures/worker-responses.json 读取预设响应
function makeFixtureFetch(fixturesDir: string): FetchLike {
  const responsesPath = `${fixturesDir}/worker-responses.json`;
  const responses = existsSync(responsesPath)
    ? (JSON.parse(readFileSync(responsesPath, "utf-8")) as Record<string, string>)
    : {};
  let callIdx = 0;
  const keys = Object.keys(responses);

  return async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body)) as { input?: Array<{ role?: string; content: Array<{ text: string }> }> };
    // 找 user message 的 text（含「我的意图: <nl>」）
    const allText = (body.input ?? []).map((m) => m.content?.[0]?.text ?? "").join(" ");
    // 按 nl 关键词匹配：key 是 worker-responses.json 里的 NL 片段
    const matchKey = keys.find((k) => allText.includes(k)) ?? keys[callIdx % Math.max(keys.length, 1)] ?? "";
    callIdx++;
    const responseText = responses[matchKey] ?? "echo fixture";
    // 返回 SSE 格式
    const sseBody = `data: {"type":"response.output_text.done","text":"${responseText.replace(/"/g, '\\"')}"}\n`;
    return new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
}

export async function runEval(opts: {
  goldPath: string;
  vocabPath?: string;
  outDir: string;
  limit?: number;
  fixturesDir?: string;
  strategy?: "vocab" | "history" | "both";
  historyCmds?: string[];
}): Promise<string> {
  const { goldPath, vocabPath, outDir, limit, fixturesDir } = opts;
  const strategy = opts.strategy ?? "vocab";

  const entries = loadGold(goldPath);
  const toRun = limit && limit > 0 ? entries.slice(0, limit) : entries;

  let vocab: VocabEntry[] = [];
  if (vocabPath && existsSync(vocabPath)) {
    vocab = JSON.parse(readFileSync(vocabPath, "utf-8")) as VocabEntry[];
  }
  // B 变体注入内容按策略选：vocab(默认) / history / both。
  const bVocab = strategy === "vocab" || strategy === "both" ? vocab : undefined;
  const bHistory = strategy === "history" || strategy === "both" ? opts.historyCmds : undefined;

  const workerCfg: WorkerConfig = {
    endpoint: "http://127.0.0.1:15721/v1/responses",
    model: "gpt/gpt-5.4-mini",
    timeoutMs: 30_000,
    fetchImpl: fixturesDir ? makeFixtureFetch(fixturesDir) : undefined,
  };

  mkdirSync(outDir, { recursive: true });
  const producedPath = `${outDir}/produced.jsonl`;
  writeFileSync(producedPath, "", "utf-8");

  for (const entry of toRun) {
    const ctx = {
      text: entry.nl,
      cwd: DEFAULT_CWD,
      recentPane: PLACEHOLDER_PANE,
    };

    const messagesA = buildVariantMessages(ctx, "A");
    const messagesB = buildVariantMessages(ctx, "B", bVocab, bHistory);

    const [produced_a, produced_b] = await Promise.all([
      callWorker(workerCfg, messagesA),
      callWorker(workerCfg, messagesB),
    ]);

    const row: ProducedEntry = {
      id: entry.id,
      nl: entry.nl,
      expected_cmd: entry.expected_cmd,
      tags: entry.tags,
      notes: entry.notes,
      cwd: DEFAULT_CWD,
      produced_a: produced_a.trim(),
      produced_b: produced_b.trim(),
    };

    const file = Bun.file(producedPath);
    const existing = await file.text();
    await Bun.write(producedPath, existing + JSON.stringify(row) + "\n");

    console.log(`[run] ${entry.id}: A="${produced_a.trim()}" B="${produced_b.trim()}"`);
  }

  return producedPath;
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  let goldPath = "eval/gold.jsonl";
  let vocabPath = "eval/vocab.json";
  let outDir = `runs/${Date.now()}`;
  let limit = 0;
  let fixturesDir = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--gold" && args[i + 1]) { goldPath = args[++i]!; }
    else if (args[i] === "--vocab" && args[i + 1]) { vocabPath = args[++i]!; }
    else if (args[i] === "--out" && args[i + 1]) { outDir = args[++i]!; }
    else if (args[i] === "--limit" && args[i + 1]) { limit = parseInt(args[++i]!, 10); }
    else if (args[i] === "--fixtures" && args[i + 1]) { fixturesDir = args[++i]!; }
  }

  const producedPath = await runEval({
    goldPath,
    vocabPath: existsSync(vocabPath) ? vocabPath : undefined,
    outDir,
    limit,
    fixturesDir: fixturesDir || undefined,
  });

  console.log(`Produced: ${producedPath}`);
}
