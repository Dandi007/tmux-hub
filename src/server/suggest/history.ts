/**
 * suggest/history.ts — zsh history 挖掘 + mtime 缓存
 *
 * 纯函数层（不执行任何命令，只解析文本 + 构 prompt 块）。
 * 缓存层（模块级，mtime 驱动）供 suggest-routes 使用。
 */

import { statSync, readFileSync } from "node:fs";

// ============================================================
// HISTORY_HEADER（与 eval 变体对齐）
// ============================================================
export const HISTORY_HEADER =
  "用户最近/常用的真实命令历史。如果其中有能达成当前意图的命令，请优先照搬复用（包括项目专属脚本名与路径），不要自己另造：";

// ============================================================
// 轻量隐私过滤：滤掉含密钥赋值的行
// ============================================================
// 含密钥关键词的变量名赋值，如 FOO_API_KEY=val, MY_TOKEN=val, SECRET_PASSWORD=val
const SECRET_RE =
  /\w*(KEY|TOKEN|SECRET|PASSWORD|PASSWD|API_KEY)\w*=[^\s]{4,}/i;

// 过长 base64/hex 赋值（≥32 个 [A-Za-z0-9+/=_-] 字符紧跟 = 赋值）
const LONG_SECRET_RE = /=[A-Za-z0-9+/=_\-]{32,}/;

function isSecretLine(cmd: string): boolean {
  return SECRET_RE.test(cmd) || LONG_SECRET_RE.test(cmd);
}

// ============================================================
// mineFrequentCommands
// ============================================================

/**
 * 解析 zsh 扩展格式（`: ts:dur;cmd`）或普通格式（每行一条命令）。
 * 返回频次降序、去重后的 top-N 命令列表。
 */
export function mineFrequentCommands(rawHistory: string, topN: number): string[] {
  const freq = new Map<string, number>();

  for (const rawLine of rawHistory.split("\n")) {
    const line = rawLine.trimEnd();
    if (line === "") continue;

    // zsh 扩展格式：`: 1234567890:0;git push`
    let cmd: string;
    const extMatch = line.match(/^:\s*\d+:\d+;(.+)$/);
    if (extMatch) {
      cmd = extMatch[1]!.trim();
    } else {
      cmd = line.trim();
    }

    if (cmd === "") continue;
    if (isSecretLine(cmd)) continue;

    freq.set(cmd, (freq.get(cmd) ?? 0) + 1);
  }

  // 频次降序；同频次保持首次出现顺序（Map iteration order）
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
  return sorted.slice(0, topN).map(([cmd]) => cmd);
}

// ============================================================
// buildHistoryBlock
// ============================================================

/**
 * 把命令列表组合成带 HISTORY_HEADER 指令的 prompt 块。
 */
export function buildHistoryBlock(cmds: string[]): string {
  if (cmds.length === 0) return "";
  return [HISTORY_HEADER, ...cmds].join("\n");
}

// ============================================================
// mtime 缓存（模块级单例）
// ============================================================

type HistoryCache = {
  mtimeMs: number;
  cmds: string[];
};

let _cache: HistoryCache | null = null;

/**
 * 读取 zsh history 文件，解析并缓存结果（mtime 驱动）。
 * 文件不存在或读失败 → 返回 null（调用方降级）。
 */
export function loadHistoryCached(filePath: string, topN: number): string[] | null {
  try {
    const st = statSync(filePath);
    if (_cache !== null && _cache.mtimeMs === st.mtimeMs) {
      return _cache.cmds;
    }
    const raw = readFileSync(filePath, "utf8");
    const cmds = mineFrequentCommands(raw, topN);
    _cache = { mtimeMs: st.mtimeMs, cmds };
    return cmds;
  } catch {
    return null;
  }
}

/** 仅测试用：清除模块级缓存 */
export function _resetCacheForTest(): void {
  _cache = null;
}
