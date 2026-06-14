import { describe, test, expect } from "bun:test";
import { buildSuggestMessages, extractCommand } from "../../src/server/suggest/prompt";

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
