import { describe, test, expect } from "bun:test";
import { parseZshHistory, isSecretLine, mineHistory } from "../mine-history";

describe("parseZshHistory", () => {
  test("zsh 扩展格式解析 `: ts:dur;cmd`", () => {
    const raw = `: 1717000000:0;git push origin HEAD\n: 1717000001:0;svc status all\n`;
    const cmds = parseZshHistory(raw);
    expect(cmds).toContain("git push origin HEAD");
    expect(cmds).toContain("svc status all");
  });

  test("多行命令（行末反斜杠续行）", () => {
    const raw = `: 1717000000:0;git commit \\\n-m "fix"\n`;
    const cmds = parseZshHistory(raw);
    expect(cmds.length).toBeGreaterThan(0);
    // 多行命令应当被合并（不是两个独立条目）
    const multiLine = cmds.find((c) => c.includes("git commit"));
    expect(multiLine).toBeTruthy();
  });

  test("旧格式（无 ts 前缀）", () => {
    const raw = `git status\ngit log\n`;
    const cmds = parseZshHistory(raw);
    expect(cmds).toContain("git status");
    expect(cmds).toContain("git log");
  });

  test("空历史返回空数组", () => {
    expect(parseZshHistory("")).toEqual([]);
    expect(parseZshHistory("\n\n")).toEqual([]);
  });
});

describe("isSecretLine", () => {
  test("含 API_KEY= 的行被标记为密钥行", () => {
    expect(isSecretLine("export FOO_API_KEY=abc123")).toBe(true);
    expect(isSecretLine("API_KEY=mysecret")).toBe(true);
    expect(isSecretLine("TOKEN=abc")).toBe(true);
    expect(isSecretLine("PASSWORD=hunter2")).toBe(true);
  });

  test("长 base64 赋值被过滤", () => {
    expect(isSecretLine("export VAR=dGhpcyBpcyBhIHZlcnkgbG9uZyBiYXNlNjQgc3RyaW5n")).toBe(true);
  });

  test("长 hex 赋值被过滤", () => {
    expect(isSecretLine("VAR=a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2")).toBe(true);
  });

  test("正常命令不被过滤", () => {
    expect(isSecretLine("git push origin HEAD")).toBe(false);
    expect(isSecretLine("svc status all")).toBe(false);
    expect(isSecretLine("cc -f")).toBe(false);
  });
});

describe("mineHistory", () => {
  test("去重 + 频次排序", () => {
    const raw = [
      ": 1:0;git push",
      ": 2:0;git push",
      ": 3:0;git push",
      ": 4:0;svc status",
      ": 5:0;svc status",
      ": 6:0;cc -f",
    ].join("\n");
    const results = mineHistory(raw, 10);
    expect(results[0]!.cmd).toBe("git push");
    expect(results[0]!.count).toBe(3);
    expect(results[1]!.cmd).toBe("svc status");
    expect(results[1]!.count).toBe(2);
  });

  test("密钥行被过滤掉", () => {
    const raw = [
      ": 1:0;git push",
      ": 2:0;export FOO_API_KEY=secret123",
      ": 3:0;TOKEN=abc123",
    ].join("\n");
    const results = mineHistory(raw, 10);
    const cmds = results.map((r) => r.cmd);
    expect(cmds).toContain("git push");
    expect(cmds.some((c) => c.includes("API_KEY"))).toBe(false);
    expect(cmds.some((c) => c.includes("TOKEN"))).toBe(false);
  });

  test("topN 限制输出数量", () => {
    const raw = Array.from({ length: 20 }, (_, i) => `: ${i}:0;cmd${i}`).join("\n");
    const results = mineHistory(raw, 5);
    expect(results.length).toBe(5);
  });
});
