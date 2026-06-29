import { describe, expect, test } from "bun:test";
import {
  getAgentStatus,
  getAgentStatusIcon,
  getAgentTitleInfo,
  getClaudeCodeStatus,
  getSessionAgentStatus,
  isAgentTitle,
  isClaudeCodeTitle,
} from "../../src/web/shared/cc-status";

describe("agent pane title status", () => {
  test("detects Claude Code idle title", () => {
    expect(getAgentStatus("✳ Implement feature")).toBe("idle");
    expect(getAgentStatusIcon("idle")).toBe("💬");
  });

  test("detects Claude Code and Codex working spinner titles", () => {
    expect(getAgentStatus("⠐ Read files")).toBe("working");
    expect(getAgentStatus("⠏ vault")).toBe("working");
    expect(getAgentStatus("⠧ vault")).toBe("working");
    expect(getAgentStatusIcon("working")).toBe("⚡");
  });

  test("treats codex session titles without spinner as idle", () => {
    expect(getSessionAgentStatus("kb-codex-20260629061455", "vault")).toBe("idle");
    expect(getAgentTitleInfo("kb-codex-20260629061455", "vault")).toEqual({
      status: "idle",
      title: "vault",
    });
  });

  test("strips spinner markers from displayed agent titles", () => {
    expect(getAgentTitleInfo("kb-codex-20260629063724", "⠋ vault")).toEqual({
      status: "working",
      title: "vault",
    });
    expect(getAgentTitleInfo("kb-cc-claude-20260629063724", "✳ Review diff")).toEqual({
      status: "idle",
      title: "Review diff",
    });
  });

  test("does not treat ordinary pane titles as agent titles", () => {
    expect(getAgentStatus("e300-nuc")).toBe("unknown");
    expect(getAgentStatus("zsh")).toBe("unknown");
    expect(isAgentTitle("e300-nuc")).toBe(false);
    expect(getSessionAgentStatus("shell-20260629061455", "vault")).toBe("unknown");
  });

  test("keeps Claude Code compatibility exports", () => {
    expect(getClaudeCodeStatus("⠏ vault")).toBe("working");
    expect(isClaudeCodeTitle("⠧ vault")).toBe(true);
  });
});
