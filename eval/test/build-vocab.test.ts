import { describe, test, expect } from "bun:test";
import { extractVocab } from "../build-vocab";

const FIXTURE_PROFILE = `
# 切换 Claude Code 到通义千问
function set_claude_ccswitch_qwen() {
  export CC_SWITCH_MODEL=qwen
}

# 切换到任意 ccswitch 模型
function set_claude_ccswitch_gpt4() {
  export CC_SWITCH_MODEL=gpt4
}

# 本机服务管理唯一入口
svc() {
  tmuxsvc "$@"
}

# 快速启动 Claude Code
cc() {
  claude "$@"
}

alias gs='git status'
alias gp='git push'
alias ll='ls -la'
`;

describe("extractVocab", () => {
  test("抽出 set_claude_ccswitch_* 函数家族", () => {
    const vocab = extractVocab(FIXTURE_PROFILE);
    const names = vocab.map((e) => e.name);
    expect(names).toContain("set_claude_ccswitch_qwen");
    expect(names).toContain("set_claude_ccswitch_gpt4");
  });

  test("抽出 svc 函数", () => {
    const vocab = extractVocab(FIXTURE_PROFILE);
    const svc = vocab.find((e) => e.name === "svc");
    expect(svc).toBeTruthy();
  });

  test("抽出 cc 函数", () => {
    const vocab = extractVocab(FIXTURE_PROFILE);
    const cc = vocab.find((e) => e.name === "cc");
    expect(cc).toBeTruthy();
  });

  test("抽出 alias（gs, gp, ll）", () => {
    const vocab = extractVocab(FIXTURE_PROFILE);
    const names = vocab.map((e) => e.name);
    expect(names).toContain("gs");
    expect(names).toContain("gp");
    expect(names).toContain("ll");
  });

  test("注释作为 purpose（前置 # 行）", () => {
    const vocab = extractVocab(FIXTURE_PROFILE);
    const qwen = vocab.find((e) => e.name === "set_claude_ccswitch_qwen");
    expect(qwen?.purpose).toContain("通义千问");
  });

  test("alias 的 purpose 包含命令体", () => {
    const vocab = extractVocab(FIXTURE_PROFILE);
    const gs = vocab.find((e) => e.name === "gs");
    expect(gs?.purpose).toContain("git status");
  });

  test("无重复条目", () => {
    const vocab = extractVocab(FIXTURE_PROFILE + FIXTURE_PROFILE);
    const names = vocab.map((e) => e.name);
    const unique = new Set(names);
    expect(names.length).toBe(unique.size);
  });
});
