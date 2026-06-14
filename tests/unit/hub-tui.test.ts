import { describe, test, expect } from "bun:test";
import {
  buildMenu,
  buildAttachCmd,
  resolveSelection,
  formatMenuItem,
  buildListOutput,
  shouldExec,
  shQuote,
} from "../../src/server/hub-tui";
import type { SessionInfo } from "../../src/shared/protocol";

describe("hub-tui pure functions", () => {
  describe("buildMenu", () => {
    test("merges sessions, templates, and new-shell item", () => {
      const sessions: SessionInfo[] = [
        { name: "s1", activity: 100, attached: 0, windows: 1, grammar_ok: true, cols: 0, rows: 0 },
        { name: "s2", activity: 200, attached: 1, windows: 2, grammar_ok: true, cols: 0, rows: 0 },
      ];
      const templates = [
        { id: "shell", name: "Shell", cwd_choices: ["~"] },
        { id: "dev", name: "Dev", cwd_choices: ["/work/dev"] },
      ];
      const menu = buildMenu(sessions, templates);
      expect(menu).toHaveLength(5); // 2 sessions + 2 templates + 1 new-shell
      expect(menu[0]!.kind).toBe("session");
      expect(menu[1]!.kind).toBe("session");
      expect(menu[2]!.kind).toBe("template");
      expect(menu[3]!.kind).toBe("template");
      expect(menu[4]!.kind).toBe("new-shell");
    });

    test("sorts sessions by activity descending", () => {
      const sessions: SessionInfo[] = [
        { name: "old", activity: 100, attached: 0, windows: 1, grammar_ok: true, cols: 0, rows: 0 },
        { name: "new", activity: 300, attached: 0, windows: 1, grammar_ok: true, cols: 0, rows: 0 },
        { name: "mid", activity: 200, attached: 0, windows: 1, grammar_ok: true, cols: 0, rows: 0 },
      ];
      const menu = buildMenu(sessions, []);
      expect(menu[0]!.kind).toBe("session");
      expect((menu[0] as any).name).toBe("new");
      expect(menu[1]!.kind).toBe("session");
      expect((menu[1] as any).name).toBe("mid");
      expect(menu[2]!.kind).toBe("session");
      expect((menu[2] as any).name).toBe("old");
    });

    test("marks attached sessions", () => {
      const sessions: SessionInfo[] = [
        { name: "attached", activity: 100, attached: 1, windows: 1, grammar_ok: true, cols: 0, rows: 0 },
        { name: "detached", activity: 200, attached: 0, windows: 1, grammar_ok: true, cols: 0, rows: 0 },
      ];
      const menu = buildMenu(sessions, []);
      expect((menu[0] as any).attached).toBe(false);
      expect((menu[1] as any).attached).toBe(true);
    });
  });

  describe("buildAttachCmd", () => {
    test("attach-session when outside tmux", () => {
      const cmd = buildAttachCmd({
        tmuxEnv: "",
        target: "mysession",
        loop: false,
      });
      expect(cmd).toEqual(["tmux", "attach-session", "-t", "mysession"]);
    });

    test("attach-session with socket when outside tmux", () => {
      const cmd = buildAttachCmd({
        tmuxEnv: "",
        target: "mysession",
        loop: false,
        socket: "hub-test",
      });
      expect(cmd).toEqual(["tmux", "-L", "hub-test", "attach-session", "-t", "mysession"]);
    });

    test("switch-client when inside tmux", () => {
      const cmd = buildAttachCmd({
        tmuxEnv: "/tmp/tmux-1000/default,12345,0",
        target: "mysession",
        loop: false,
      });
      expect(cmd).toEqual(["tmux", "switch-client", "-t", "mysession"]);
    });

    test("switch-client with socket when inside tmux", () => {
      const cmd = buildAttachCmd({
        tmuxEnv: "/tmp/tmux-1000/default,12345,0",
        target: "mysession",
        loop: false,
        socket: "hub-test",
      });
      expect(cmd).toEqual(["tmux", "-L", "hub-test", "switch-client", "-t", "mysession"]);
    });

    test("loop mode does not change command structure", () => {
      const cmd = buildAttachCmd({
        tmuxEnv: "",
        target: "mysession",
        loop: true,
      });
      expect(cmd).toEqual(["tmux", "attach-session", "-t", "mysession"]);
    });
  });

  describe("shouldExec", () => {
    test("exec when outside tmux and not looping", () => {
      expect(shouldExec({ tmuxEnv: "", target: "x", loop: false })).toBe(true);
    });

    test("no exec when inside tmux", () => {
      expect(shouldExec({ tmuxEnv: "/tmp/tmux-1000/default", target: "x", loop: false })).toBe(false);
    });

    test("no exec when looping", () => {
      expect(shouldExec({ tmuxEnv: "", target: "x", loop: true })).toBe(false);
    });
  });

  describe("resolveSelection", () => {
    test("resolves session selection", () => {
      const menu = buildMenu(
        [{ name: "s1", activity: 100, attached: 0, windows: 1, grammar_ok: true, cols: 0, rows: 0 }],
        [],
      );
      const action = resolveSelection(menu, 0);
      expect(action).toEqual({ action: "attach", sessionName: "s1" });
    });

    test("resolves template selection", () => {
      const menu = buildMenu([], [{ id: "shell", name: "Shell", cwd_choices: ["~"] }]);
      const action = resolveSelection(menu, 0);
      expect(action).toEqual({ action: "run-template", templateId: "shell", cwd: "~" });
    });

    test("template selection carries the template's cwd_choices[0], not hardcoded ~", () => {
      // Regression for the bug where the TUI POSTed {cwd:"~"} for every template,
      // which the server rejected (400) for templates whose cwd_choices is an
      // absolute path — so Enter on those templates silently bounced to the menu.
      const absCwd = "/Users/x/Library/Mobile Documents/iCloud~md~obsidian/Documents/Zettelkasten";
      const menu = buildMenu([], [{ id: "kb-cc", name: "知识库 cc", cwd_choices: [absCwd] }]);
      const action = resolveSelection(menu, 0);
      expect(action).toEqual({ action: "run-template", templateId: "kb-cc", cwd: absCwd });
      expect((action as { cwd: string }).cwd).not.toBe("~");
    });

    test("resolves new-shell selection", () => {
      const menu = buildMenu([], []);
      const action = resolveSelection(menu, 0);
      expect(action).toEqual({ action: "new-shell" });
    });

    test("returns quit for out-of-bounds index", () => {
      const menu = buildMenu([], []);
      const action = resolveSelection(menu, 999);
      expect(action).toEqual({ action: "quit" });
    });

    test("returns quit for negative index", () => {
      const menu = buildMenu([], []);
      const action = resolveSelection(menu, -1);
      expect(action).toEqual({ action: "quit" });
    });
  });

  describe("formatMenuItem", () => {
    test("formats attached session with marker", () => {
      const menu = buildMenu(
        [{ name: "s1", activity: 100, attached: 1, windows: 1, grammar_ok: true, cols: 0, rows: 0 }],
        [],
      );
      const formatted = formatMenuItem(menu[0]!);
      expect(formatted).toContain("●");
      expect(formatted).toContain("s1");
    });

    test("formats detached session without marker", () => {
      const menu = buildMenu(
        [{ name: "s1", activity: 100, attached: 0, windows: 1, grammar_ok: true, cols: 0, rows: 0 }],
        [],
      );
      const formatted = formatMenuItem(menu[0]!);
      expect(formatted).not.toContain("●");
      expect(formatted).toContain("s1");
    });

    test("formats template with arrow", () => {
      const menu = buildMenu([], [{ id: "shell", name: "Shell", cwd_choices: ["~"] }]);
      const formatted = formatMenuItem(menu[0]!);
      expect(formatted).toContain("▸");
      expect(formatted).toContain("Shell");
      expect(formatted).toContain("template: shell");
    });

    test("formats new-shell with plus", () => {
      const menu = buildMenu([], []);
      const formatted = formatMenuItem(menu[0]!);
      expect(formatted).toContain("+");
      expect(formatted).toContain("new shell");
    });
  });

  describe("buildListOutput", () => {
    test("produces JSON-serializable output", () => {
      const sessions: SessionInfo[] = [
        { name: "s1", activity: 100, attached: 1, windows: 2, grammar_ok: true, cols: 0, rows: 0 },
      ];
      const templates = [{ id: "shell", name: "Shell", cwd_choices: ["~"] }];
      const output = buildListOutput(sessions, templates);
      expect(output.sessions).toHaveLength(1);
      expect(output.sessions[0]!.name).toBe("s1");
      expect(output.sessions[0]!.attached).toBe(true);
      expect(output.templates).toHaveLength(1);
      expect(output.templates[0]!.id).toBe("shell");
    });
  });

  describe("shQuote", () => {
    test("passes safe tokens through unquoted", () => {
      expect(shQuote("tmux")).toBe("tmux");
      expect(shQuote("attach-session")).toBe("attach-session");
      expect(shQuote("my-session")).toBe("my-session");
    });

    test("quotes tokens with spaces", () => {
      const quoted = shQuote("my session");
      expect(quoted).toBe("'my session'");
      // Verify it round-trips through sh -c
      const result = Bun.spawnSync(["sh", "-c", `printf '%s' ${quoted}`]);
      expect(new TextDecoder().decode(result.stdout)).toBe("my session");
    });

    test("quotes tokens with single quotes", () => {
      const quoted = shQuote("it's a test");
      expect(quoted).toContain("'");
      const result = Bun.spawnSync(["sh", "-c", `printf '%s' ${quoted}`]);
      expect(new TextDecoder().decode(result.stdout)).toBe("it's a test");
    });

    test("buildAttachCmd output with shQuote survives shell parsing for spaced session names", () => {
      const cmd = buildAttachCmd({
        tmuxEnv: "",
        target: "my session name",
        loop: false,
      });
      const quoted = cmd.map(shQuote).join(" ");
      // The quoted string should parse back to the same argv via sh -c
      const result = Bun.spawnSync(["sh", "-c", `printf '%s\\n' ${quoted}`]);
      const lines = new TextDecoder().decode(result.stdout).trim().split("\n");
      expect(lines).toEqual(["tmux", "attach-session", "-t", "my session name"]);
    });
  });

  describe("fzf absent fallback", () => {
    test("resolveSelection works as fallback when fzf is unavailable", () => {
      // When fzf is absent, the numbered menu uses resolveSelection(index)
      // to map user input to actions. This tests that the fallback path works.
      const menu = buildMenu(
        [
          { name: "s1", activity: 100, attached: 0, windows: 1, grammar_ok: true, cols: 0, rows: 0 },
          { name: "s2", activity: 200, attached: 0, windows: 1, grammar_ok: true, cols: 0, rows: 0 },
        ],
        [{ id: "shell", name: "Shell", cwd_choices: ["~"] }],
      );
      // buildMenu sorts by activity descending, so s2 (200) comes before s1 (100)
      // Selecting index 0 → first session (s2, highest activity)
      expect(resolveSelection(menu, 0)).toEqual({ action: "attach", sessionName: "s2" });
      // Selecting index 1 → second session (s1)
      expect(resolveSelection(menu, 1)).toEqual({ action: "attach", sessionName: "s1" });
      // Selecting index 2 → template
      expect(resolveSelection(menu, 2)).toEqual({ action: "run-template", templateId: "shell", cwd: "~" });
      // Selecting index 3 → new-shell
      expect(resolveSelection(menu, 3)).toEqual({ action: "new-shell" });
    });
  });

  describe("--print-cmd with spaced session names", () => {
    test("buildAttachCmd output with shQuote survives shell parsing", () => {
      const cmd = buildAttachCmd({
        tmuxEnv: "",
        target: "my session name",
        loop: false,
      });
      const quoted = cmd.map(shQuote).join(" ");
      // The quoted string should parse back to the same argv via sh -c
      const result = Bun.spawnSync(["sh", "-c", `printf '%s\\n' ${quoted}`]);
      const lines = new TextDecoder().decode(result.stdout).trim().split("\n");
      expect(lines).toEqual(["tmux", "attach-session", "-t", "my session name"]);
    });

    test("buildAttachCmd with socket and spaced name", () => {
      const cmd = buildAttachCmd({
        tmuxEnv: "",
        target: "test session",
        loop: false,
        socket: "hub-test",
      });
      const quoted = cmd.map(shQuote).join(" ");
      const result = Bun.spawnSync(["sh", "-c", `printf '%s\\n' ${quoted}`]);
      const lines = new TextDecoder().decode(result.stdout).trim().split("\n");
      expect(lines).toEqual(["tmux", "-L", "hub-test", "attach-session", "-t", "test session"]);
    });
  });

  describe("--loop control flow", () => {
    test("buildAttachCmd in loop mode does not change command structure", () => {
      const cmd = buildAttachCmd({
        tmuxEnv: "",
        target: "mysession",
        loop: true,
      });
      expect(cmd).toEqual(["tmux", "attach-session", "-t", "mysession"]);
    });

    test("shouldExec returns false in loop mode", () => {
      expect(shouldExec({ tmuxEnv: "", target: "x", loop: true })).toBe(false);
    });

    test("shouldExec returns false inside tmux even without loop", () => {
      expect(shouldExec({ tmuxEnv: "/tmp/tmux-1000/default", target: "x", loop: false })).toBe(false);
    });

    test("shouldExec returns true only outside tmux and not looping", () => {
      expect(shouldExec({ tmuxEnv: "", target: "x", loop: false })).toBe(true);
    });
  });
});
