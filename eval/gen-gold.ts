#!/usr/bin/env bun
/**
 * eval/gen-gold.ts
 *
 * 每条候选命令交 Opus 生成「用户会怎么说」的 NL
 * → gold.jsonl（committed fixture）
 *
 * 用法：
 *   bun eval/gen-gold.ts [--candidates <path>] [--out eval/gold.jsonl] [--limit <N>]
 *
 * candidates：mine-history 输出的 JSON 数组
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { callOpus, type OpusConfig } from "./lib/clients";
import { buildGoldGenPrompt, JUDGE_SYSTEM } from "./lib/prompts";

export type GoldEntry = {
  id: string;
  nl: string;
  expected_cmd: string;
  tags: string[];
  notes: string;
};

function parseOpusGold(text: string, fallbackId: string, cmd: string): GoldEntry {
  // Strip markdown code fences if present
  const cleaned = text.replace(/^```[^\n]*\n?/, "").replace(/\n?```\s*$/, "").trim();
  try {
    const parsed = JSON.parse(cleaned) as Partial<GoldEntry>;
    return {
      id: parsed.id ?? fallbackId,
      nl: parsed.nl ?? "",
      expected_cmd: parsed.expected_cmd ?? cmd,
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      notes: parsed.notes ?? "",
    };
  } catch {
    // Fallback: construct minimal entry
    return { id: fallbackId, nl: text.slice(0, 60), expected_cmd: cmd, tags: ["general"], notes: "" };
  }
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  let candidatesPath = "eval/candidates.json";
  let outPath = "eval/gold.jsonl";
  let limit = 0;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--candidates" && args[i + 1]) { candidatesPath = args[++i]!; }
    else if (args[i] === "--out" && args[i + 1]) { outPath = args[++i]!; }
    else if (args[i] === "--limit" && args[i + 1]) { limit = parseInt(args[++i]!, 10); }
  }

  if (!existsSync(candidatesPath)) {
    console.error(`candidates not found: ${candidatesPath}`);
    process.exit(1);
  }

  const candidates = JSON.parse(readFileSync(candidatesPath, "utf-8")) as Array<{ cmd: string; count: number }>;
  const toProcess = limit > 0 ? candidates.slice(0, limit) : candidates;

  const opusCfg: OpusConfig = {
    endpoint: "http://127.0.0.1:15721/v1/messages",
    model: "lingzhi/claude-opus-4-8",
    maxTokens: 512,
    timeoutMs: 30_000,
  };

  // Clear output file
  writeFileSync(outPath, "", "utf-8");

  let idx = 1;
  for (const { cmd } of toProcess) {
    const id = `g${String(idx).padStart(3, "0")}`;
    const prompt = buildGoldGenPrompt(cmd, idx);
    try {
      const rawText = await callOpus(opusCfg, "你是 shell 命令自然语言生成助手，只输出 JSON。", [
        { role: "user", content: prompt },
      ]);
      const entry = parseOpusGold(rawText, id, cmd);
      appendFileSync(outPath, JSON.stringify(entry) + "\n", "utf-8");
      console.log(`[${idx}/${toProcess.length}] ${id}: ${entry.nl}`);
    } catch (e) {
      console.error(`[${idx}] failed for ${cmd}: ${e}`);
    }
    idx++;
  }

  console.log(`Done. Gold written to ${outPath}`);
}
