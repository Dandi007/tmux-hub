import { describe, expect, test } from "bun:test";
import {
  getAgentStatus,
  getAgentStatusIcon,
  getClaudeCodeStatus,
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

  test("does not treat ordinary pane titles as agent titles", () => {
    expect(getAgentStatus("e300-nuc")).toBe("unknown");
    expect(getAgentStatus("zsh")).toBe("unknown");
    expect(isAgentTitle("e300-nuc")).toBe(false);
  });

  test("keeps Claude Code compatibility exports", () => {
    expect(getClaudeCodeStatus("⠏ vault")).toBe("working");
    expect(isClaudeCodeTitle("⠧ vault")).toBe(true);
  });
});
