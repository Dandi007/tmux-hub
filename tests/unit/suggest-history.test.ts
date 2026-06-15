import { describe, test, expect, beforeEach } from "bun:test";
import { mineFrequentCommands, buildHistoryBlock, HISTORY_HEADER, _resetCacheForTest } from "../../src/server/suggest/history";

beforeEach(() => {
  _resetCacheForTest();
});

describe("mineFrequentCommands", () => {
  test("zsh 扩展格式 `: ts:dur;cmd` 解析", () => {
    const raw = [
      ": 1700000000:0;git status",
      ": 1700000001:0;git push",
      ": 1700000002:0;git status",
    ].join("\n");
    const cmds = mineFrequentCommands(raw, 10);
    expect(cmds).toContain("git status");
    expect(cmds).toContain("git push");
    // git status 频次更高，排在前面
    expect(cmds.indexOf("git status")).toBeLessThan(cmds.indexOf("git push"));
  });

  test("去重：同一命令只出现一次", () => {
    const raw = [
      ": 1700000000:0;ls -la",
      ": 1700000001:0;ls -la",
      ": 1700000002:0;ls -la",
    ].join("\n");
    const cmds = mineFrequentCommands(raw, 10);
    expect(cmds.filter((c) => c === "ls -la").length).toBe(1);
  });

  test("频次降序 top-N", () => {
    const lines: string[] = [];
    // a 出现 5 次，b 出现 3 次，c 出现 1 次
    for (let i = 0; i < 5; i++) lines.push(`: 170000000${i}:0;cmd-a`);
    for (let i = 0; i < 3; i++) lines.push(`: 170000001${i}:0;cmd-b`);
    lines.push(": 1700000020:0;cmd-c");
    const cmds = mineFrequentCommands(lines.join("\n"), 2);
    expect(cmds).toHaveLength(2);
    expect(cmds[0]).toBe("cmd-a");
    expect(cmds[1]).toBe("cmd-b");
    expect(cmds).not.toContain("cmd-c");
  });

  test("密钥行被滤（KEY= / TOKEN= / SECRET=）", () => {
    const raw = [
      ": 1700000000:0;export FOO_API_KEY=abc123secret",
      ": 1700000001:0;export MY_TOKEN=eyJhbGciOiJSUzI1NiJ9",
      ": 1700000002:0;git log",
    ].join("\n");
    const cmds = mineFrequentCommands(raw, 10);
    expect(cmds).not.toContain("export FOO_API_KEY=abc123secret");
    expect(cmds).not.toContain("export MY_TOKEN=eyJhbGciOiJSUzI1NiJ9");
    expect(cmds).toContain("git log");
  });

  test("PASSWORD= 行被滤", () => {
    const raw = ": 1700000000:0;mysql -u root -pSECRET_PASSWORD=hunter2\n: 1700000001:0;ls";
    const cmds = mineFrequentCommands(raw, 10);
    expect(cmds).not.toContain("mysql -u root -pSECRET_PASSWORD=hunter2");
    expect(cmds).toContain("ls");
  });

  test("普通格式（非扩展）也能解析", () => {
    const raw = "git status\ngit push\ngit status";
    const cmds = mineFrequentCommands(raw, 10);
    expect(cmds).toContain("git status");
    expect(cmds).toContain("git push");
    expect(cmds.indexOf("git status")).toBeLessThan(cmds.indexOf("git push"));
  });

  test("空输入 → 空数组", () => {
    expect(mineFrequentCommands("", 10)).toEqual([]);
    expect(mineFrequentCommands("\n\n", 10)).toEqual([]);
  });

  test("top-N=0 → 空数组", () => {
    const raw = ": 1700000000:0;git status";
    expect(mineFrequentCommands(raw, 0)).toEqual([]);
  });
});

describe("buildHistoryBlock", () => {
  test("含 HISTORY_HEADER", () => {
    const block = buildHistoryBlock(["git status", "git push"]);
    expect(block).toContain(HISTORY_HEADER);
  });

  test("含所有命令", () => {
    const block = buildHistoryBlock(["git status", "ls -la"]);
    expect(block).toContain("git status");
    expect(block).toContain("ls -la");
  });

  test("空命令列表 → 空串", () => {
    expect(buildHistoryBlock([])).toBe("");
  });
});
