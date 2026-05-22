import { describe, test, expect } from "bun:test";
import { parseTemplatesYaml } from "../../src/server/config";

describe("templates schema", () => {
  test("parses valid yaml", () => {
    const yaml = `
templates:
  - id: codex
    name: "Codex 新会话"
    cwd_choices: ["~/code/a", "~/code/b"]
    cmd: "codex"
`;
    const t = parseTemplatesYaml(yaml);
    expect(t).toHaveLength(1);
    expect(t[0]!.id).toBe("codex");
    expect(t[0]!.cwd_choices).toEqual(["~/code/a", "~/code/b"]);
  });

  test("rejects missing cmd", () => {
    const yaml = `templates:\n  - id: x\n    name: X\n    cwd_choices: ["~"]\n`;
    expect(() => parseTemplatesYaml(yaml)).toThrow();
  });

  test("rejects empty cwd_choices", () => {
    const yaml = `templates:\n  - id: x\n    name: X\n    cwd_choices: []\n    cmd: zsh\n`;
    expect(() => parseTemplatesYaml(yaml)).toThrow();
  });

  test("rejects non-string cmd", () => {
    const yaml = `templates:\n  - id: x\n    name: X\n    cwd_choices: ["~"]\n    cmd: 42\n`;
    expect(() => parseTemplatesYaml(yaml)).toThrow();
  });

  test("rejects id with uppercase or dot", () => {
    const yaml1 = `templates:\n  - id: Codex\n    name: X\n    cwd_choices: ["~"]\n    cmd: zsh\n`;
    expect(() => parseTemplatesYaml(yaml1)).toThrow();
    const yaml2 = `templates:\n  - id: cd.ex\n    name: X\n    cwd_choices: ["~"]\n    cmd: zsh\n`;
    expect(() => parseTemplatesYaml(yaml2)).toThrow();
  });

  test("accepts empty templates array", () => {
    const yaml = `templates: []`;
    const t = parseTemplatesYaml(yaml);
    expect(t).toHaveLength(0);
  });
});
