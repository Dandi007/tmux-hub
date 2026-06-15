/**
 * eval/lib/prompts.ts
 *
 * 构建 A/B 变体的 messages、gold-gen prompt、judge prompt。
 *
 * 变体 A：复用线上 buildSuggestMessages（归因前提）
 * 变体 B：A 的 system 末尾追加命令词汇字典块
 */

import { buildSuggestMessages, type SuggestContext, type ChatMessage } from "../../src/server/suggest/prompt";

export { buildSuggestMessages };

// ——— A/B 变体 ———

export type Variant = "A" | "B";

export type VocabEntry = {
  name: string;       // 函数/别名名称
  purpose: string;    // 一行用途
};

const VOCAB_HEADER = "用户的自定义命令（优先使用，胜过通用命令）：";
const HISTORY_HEADER = "用户最近/常用的真实命令历史。如果其中有能达成当前意图的命令，请优先照搬复用（包括项目专属脚本名与路径），不要自己另造：";

export function buildVocabBlock(vocab: VocabEntry[]): string {
  return [VOCAB_HEADER, ...vocab.map((e) => `- ${e.name} — ${e.purpose}`)].join("\n");
}

export function buildHistoryBlock(cmds: string[]): string {
  return [HISTORY_HEADER, ...cmds.map((c) => `- ${c}`)].join("\n");
}

// B 变体 = A 的 system 末尾追加增强块。增强块由 vocab（命令词汇字典）和/或
// historyCmds（历史命令）拼成——三种策略：仅 vocab / 仅 history / 两者(both)。
// 向后兼容：第 3 参 vocab 数组照旧；第 4 参 historyCmds 新增。
export function buildVariantMessages(
  ctx: SuggestContext,
  variant: Variant,
  vocab?: VocabEntry[],
  historyCmds?: string[],
): ChatMessage[] {
  const base = buildSuggestMessages(ctx);
  if (variant === "A") return base;

  const blocks: string[] = [];
  if (vocab && vocab.length > 0) blocks.push(buildVocabBlock(vocab));
  if (historyCmds && historyCmds.length > 0) blocks.push(buildHistoryBlock(historyCmds));
  if (blocks.length === 0) return base;
  const aug = blocks.join("\n\n");

  return base.map((msg) =>
    msg.role === "system" ? { ...msg, content: msg.content + "\n\n" + aug } : msg,
  );
}

// ——— Gold-gen prompt（Opus 生成 gold.jsonl）———

export function buildGoldGenPrompt(cmd: string, index: number): string {
  return [
    "你是一名熟悉 shell 和终端操作的中文用户。",
    "给你一条真实的 shell 命令，请生成一条「用户会如何用自然语言描述这个意图」的中文问句（NL）。",
    "要求：",
    "1. NL 要口语化，就像用户在说话一样，不要直接说出命令名称。",
    "2. NL 长度 5–25 字。",
    "3. 同时给这条用例打 1–3 个 tags，从以下集合选：custom-fn / svc / git / proxy / file / k8s / model-switch / general。",
    "4. 如果这条命令通常还需要接着做某件事，在 notes 字段简述（否则留空字符串）。",
    "",
    "严格以 JSON 对象输出，格式：",
    `{"id":"g${String(index).padStart(3, "0")}","nl":"...","expected_cmd":"${cmd}","tags":["..."],"notes":"..."}`,
    "",
    `命令：${cmd}`,
  ].join("\n");
}

// ——— Judge prompt（Opus 判分）———

export type JudgeInput = {
  nl: string;
  expected_cmd: string;
  produced_a: string;
  produced_b: string;
};

export const JUDGE_SYSTEM = [
  "你是一名 shell 命令评分专家。",
  "给你：用户的自然语言意图（nl）、期望命令（expected_cmd）、A 变体产出（produced_a）、B 变体产出（produced_b）。",
  "对 A 和 B 各自独立给出 verdict，三档：",
  "  correct：与 expected_cmd 功能等价（含等价写法/flag 顺序/简写）。",
  "  variant：达成同一意图的合理不同做法（可接受但非 gold 首选）。",
  "  wrong：选错工具/语义跑偏/不可执行/幻觉。",
  "",
  "严格以 JSON 对象输出，格式：",
  '{"verdict_a":"correct|variant|wrong","rationale_a":"...","verdict_b":"correct|variant|wrong","rationale_b":"..."}',
  "不要输出任何 JSON 以外的内容。",
].join("\n");

export function buildJudgeUserMessage(input: JudgeInput): string {
  return [
    `nl: ${input.nl}`,
    `expected_cmd: ${input.expected_cmd}`,
    `produced_a: ${input.produced_a}`,
    `produced_b: ${input.produced_b}`,
  ].join("\n");
}
