export type SuggestContext = { text: string; cwd: string; recentPane: string };
export type ChatMessage = { role: "system" | "user"; content: string };

const SYSTEM = [
  "你是一个把自然语言意图翻译成单条 shell 命令的助手。",
  "规则：",
  "1. 只输出一行可直接在当前 shell 执行的命令，不要解释、不要 markdown、不要代码块包裹。",
  "2. 如果用户输入本身已是合法命令，原样返回。",
  "3. 充分利用给定的当前工作目录和最近终端输出作为上下文。",
  "4. 不确定时给出最可能的单条命令。",
].join("\n");

export function buildSuggestMessages(ctx: SuggestContext): ChatMessage[] {
  const user = [
    `当前工作目录: ${ctx.cwd || "(未知)"}`,
    "",
    "最近终端输出:",
    ctx.recentPane || "(空)",
    "",
    `我的意图: ${ctx.text}`,
  ].join("\n");
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}

// 抽出可执行命令：剥代码块/反引号，取首个非空行（P0 只取单行，防模型多嘴误执行）。
export function extractCommand(raw: string): string {
  let s = raw.trim();
  const fence = s.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fence) s = fence[1]!.trim();
  if (s.length >= 2 && s.startsWith("`") && s.endsWith("`")) s = s.slice(1, -1).trim();
  return s.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
}
