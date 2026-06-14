import { describe, test, expect } from "bun:test";
import { classifyPaneCommand } from "../../src/server/suggest/classify";

describe("classifyPaneCommand", () => {
  test("known shells → shell", () => {
    for (const c of ["zsh", "bash", "fish", "sh"]) {
      expect(classifyPaneCommand(c)).toBe("shell");
    }
  });
  test("trims whitespace", () => {
    expect(classifyPaneCommand(" zsh\n")).toBe("shell");
  });
  test("TUI / foreground processes → other", () => {
    for (const c of ["node", "claude", "python", "vim", "less", "git", ""]) {
      expect(classifyPaneCommand(c)).toBe("other");
    }
  });
});
