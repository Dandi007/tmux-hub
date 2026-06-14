#!/usr/bin/env bun
/**
 * eval/build-vocab.ts
 *
 * 从 agent-shell/profile.zsh 抽函数/别名（名+一行用途）
 * + history top-N → vocab.json
 *
 * 用法：
 *   bun eval/build-vocab.ts [--profile <path>] [--history <path>] [--top <N>] [--out <file>]
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { mineHistory } from "./mine-history";
import type { VocabEntry } from "./lib/prompts";

// ——— 从 profile.zsh 抽函数/别名 ———

/**
 * 抽取 zsh profile 里的函数定义和别名。
 * 策略：
 *   - alias xxx='...'  → name=xxx, purpose=（命令体截断到 60 chars）
 *   - function xxx() 或 xxx() { → 寻找紧前面的注释行作 purpose
 *   - 如无注释，取函数体第一个非空行截断
 */
export function extractVocab(profileText: string): VocabEntry[] {
  const lines = profileText.split("\n");
  const entries: VocabEntry[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    // alias
    const aliasMatch = line.match(/^\s*alias\s+([A-Za-z_][A-Za-z0-9_.-]*)=(['"]?)(.+)\2\s*$/);
    if (aliasMatch) {
      const name = aliasMatch[1]!;
      const body = aliasMatch[3]!.replace(/^['"]|['"]$/g, "").slice(0, 80);
      if (!seen.has(name)) {
        seen.add(name);
        entries.push({ name, purpose: body });
      }
      continue;
    }

    // function definition: `function foo {`, `function foo() {`, `foo() {`, `foo () {`
    const fnMatch = line.match(/^\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*\(\s*\)\s*\{?\s*$/)
      || line.match(/^\s*function\s+([A-Za-z_][A-Za-z0-9_.-]*)\s*\{?\s*$/);
    if (fnMatch) {
      const name = fnMatch[1]!;
      if (seen.has(name)) continue;
      seen.add(name);

      // 寻找紧前面的注释行
      let purpose = "";
      for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
        const prev = (lines[j] ?? "").trim();
        if (prev.startsWith("#")) {
          purpose = prev.replace(/^#+\s*/, "").slice(0, 100);
          break;
        }
        if (prev !== "") break; // 遇到非空非注释行，停止
      }

      // 若无注释，取函数体首行
      if (!purpose) {
        for (let j = i + 1; j < lines.length && j <= i + 5; j++) {
          const bodyLine = (lines[j] ?? "").trim();
          if (bodyLine && !bodyLine.startsWith("#") && bodyLine !== "{" && bodyLine !== "}") {
            purpose = bodyLine.slice(0, 80);
            break;
          }
        }
      }

      entries.push({ name, purpose: purpose || name });
      continue;
    }
  }

  return entries;
}

// ——— CLI entrypoint ———

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  // 尝试默认 profile 路径
  const defaultProfile = `${homedir()}/code/self/agent-shell/profile.zsh`;
  let profilePath = existsSync(defaultProfile) ? defaultProfile : "";
  let historyPath = `${homedir()}/.zsh_history`;
  let topN = 50;
  let outPath = "eval/vocab.json";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--profile" && args[i + 1]) { profilePath = args[++i]!; }
    else if (args[i] === "--history" && args[i + 1]) { historyPath = args[++i]!; }
    else if (args[i] === "--top" && args[i + 1]) { topN = parseInt(args[++i]!, 10); }
    else if (args[i] === "--out" && args[i + 1]) { outPath = args[++i]!; }
  }

  const vocabEntries: VocabEntry[] = [];

  // From profile
  if (profilePath && existsSync(profilePath)) {
    const profileText = readFileSync(profilePath, "utf-8");
    const extracted = extractVocab(profileText);
    vocabEntries.push(...extracted);
    console.log(`Extracted ${extracted.length} entries from profile`);
  } else {
    console.warn("profile.zsh not found, skipping function/alias extraction");
  }

  // From history (top-N as plain command names)
  if (existsSync(historyPath)) {
    const raw = readFileSync(historyPath, "utf-8");
    const topCmds = mineHistory(raw, topN);
    for (const { cmd } of topCmds) {
      // 取命令首个词作为词汇条目（若尚未收录）
      const firstWord = cmd.trim().split(/\s+/)[0] ?? "";
      if (firstWord && !vocabEntries.find((e) => e.name === firstWord)) {
        vocabEntries.push({ name: firstWord, purpose: `高频命令: ${cmd.slice(0, 60)}` });
      }
    }
  }

  writeFileSync(outPath, JSON.stringify(vocabEntries, null, 2), "utf-8");
  console.log(`Wrote ${vocabEntries.length} vocab entries to ${outPath}`);
}
