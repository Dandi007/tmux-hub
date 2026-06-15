import { describe, test, expect } from "bun:test";
import { buildSuggestMessages, extractCommand } from "../../src/server/suggest/prompt";
import { HISTORY_HEADER } from "../../src/server/suggest/history";

describe("buildSuggestMessages", () => {
  test("system + user, user 含 cwd / 终端输出 / 意图", () => {
    const msgs = buildSuggestMessages({ text: "把分支推上去", cwd: "/repo", recentPane: "$ git status" });
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[1]!.role).toBe("user");
    expect(msgs[1]!.content).toContain("/repo");
    expect(msgs[1]!.content).toContain("$ git status");
    expect(msgs[1]!.content).toContain("把分支推上去");
  });
  test("空 cwd / 空 pane 用占位符不报错", () => {
    const msgs = buildSuggestMessages({ text: "ls", cwd: "", recentPane: "" });
    expect(msgs[1]!.content).toContain("ls");
  });
  test("system 含「禁止自然语言占位」规则（防中文占位塞进命令）", () => {
    const msgs = buildSuggestMessages({ text: "x", cwd: "", recentPane: "" });
    expect(msgs[0]!.content).toContain("尖括号占位");
  });
  test("不传 opts → system 不含 HISTORY_HEADER（向后兼容）", () => {
    const msgs = buildSuggestMessages({ text: "x", cwd: "", recentPane: "" });
    expect(msgs[0]!.content).not.toContain(HISTORY_HEADER);
  });
  test("opts.historyBlock 为空串 → system 不含 HISTORY_HEADER", () => {
    const msgs = buildSuggestMessages({ text: "x", cwd: "", recentPane: "" }, { historyBlock: "" });
    expect(msgs[0]!.content).not.toContain(HISTORY_HEADER);
  });
  test("opts.historyBlock 非空 → system 末尾含历史块", () => {
    const block = `${HISTORY_HEADER}\ngit status`;
    const msgs = buildSuggestMessages({ text: "x", cwd: "", recentPane: "" }, { historyBlock: block });
    expect(msgs[0]!.content).toContain(HISTORY_HEADER);
    expect(msgs[0]!.content).toContain("git status");
  });
});

describe("extractCommand", () => {
  test("原样单行", () => {
    expect(extractCommand("git push -u origin HEAD")).toBe("git push -u origin HEAD");
  });
  test("剥 ``` 代码块围栏", () => {
    expect(extractCommand("```sh\ngit push\n```")).toBe("git push");
  });
  test("剥单行反引号", () => {
    expect(extractCommand("`ls -la`")).toBe("ls -la");
  });
  test("取首个非空行（模型多嘴时）", () => {
    expect(extractCommand("git status\n\n这会显示状态")).toBe("git status");
  });
  test("纯空白 → 空串", () => {
    expect(extractCommand("   \n  ")).toBe("");
  });
});
