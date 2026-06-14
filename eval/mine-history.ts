#!/usr/bin/env bun
/**
 * eval/mine-history.ts
 *
 * 解析 ~/.zsh_history（zsh 扩展格式 `: ts:dur;cmd`）
 * → 去重 → 频次排序 → 轻量滤密钥行 → 候选命令 JSON
 *
 * 用法：
 *   bun eval/mine-history.ts [--history <path>] [--top <N>] [--out <file>]
 * 默认: ~/.zsh_history, top 200, stdout
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";

// ——— 密钥行过滤（轻量防御）———

const SECRET_PATTERNS: RegExp[] = [
  /\b(KEY|TOKEN|SECRET|PASSWORD|PASSWD|API_KEY)\s*=/i,
  /\bexport\s+\w*(KEY|TOKEN|SECRET|PASSWORD|API)\w*\s*=/i,
  // 明显长 base64/hex 赋值（40+ chars 的纯 base64/hex 值）
  /=\s*[A-Za-z0-9+/]{40,}={0,2}\b/,
  /=\s*[0-9a-fA-F]{40,}\b/,
];

export function isSecretLine(line: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(line));
}

// ——— zsh 扩展格式解析 ———
// 格式：`: <timestamp>:<duration>;<command>`
// 多行命令：行末反斜杠续行（下一行不以 `: ` 开头）

export function parseZshHistory(raw: string): string[] {
  const lines = raw.split("\n");
  const commands: string[] = [];
  let current = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    if (current === "") {
      // 新条目
      const m = line.match(/^:\s*\d+:\d+;(.*)$/);
      if (m) {
        current = m[1] ?? "";
      } else if (line.trim() !== "") {
        // 旧格式（无 ts）
        current = line;
      }
    } else {
      // 续行（行末有反斜杠）
      current = current + "\n" + line;
    }

    // 若当前行不以反斜杠结尾，条目结束
    if (current !== "" && !current.endsWith("\\")) {
      commands.push(current.trimEnd());
      current = "";
    } else if (current.endsWith("\\")) {
      // 去掉续行符，等待下一行
      current = current.slice(0, -1);
    }
  }
  if (current.trim() !== "") commands.push(current.trimEnd());
  return commands;
}

// ——— 主流程 ———

export function mineHistory(raw: string, topN: number): Array<{ cmd: string; count: number }> {
  const parsed = parseZshHistory(raw);

  // 去重 + 频次
  const freq = new Map<string, number>();
  for (const cmd of parsed) {
    const trimmed = cmd.trim();
    if (trimmed === "") continue;
    if (isSecretLine(trimmed)) continue;
    freq.set(trimmed, (freq.get(trimmed) ?? 0) + 1);
  }

  // 按频次降序
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([cmd, count]) => ({ cmd, count }));
}

// ——— CLI entrypoint ———

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  let historyPath = `${homedir()}/.zsh_history`;
  let topN = 200;
  let outPath = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--history" && args[i + 1]) { historyPath = args[++i]!; }
    else if (args[i] === "--top" && args[i + 1]) { topN = parseInt(args[++i]!, 10); }
    else if (args[i] === "--out" && args[i + 1]) { outPath = args[++i]!; }
  }

  if (!existsSync(historyPath)) {
    console.error(`history file not found: ${historyPath}`);
    process.exit(1);
  }

  const raw = readFileSync(historyPath, "utf-8");
  const results = mineHistory(raw, topN);

  const json = JSON.stringify(results, null, 2);
  if (outPath) {
    writeFileSync(outPath, json, "utf-8");
    console.log(`Wrote ${results.length} commands to ${outPath}`);
  } else {
    console.log(json);
  }
}
