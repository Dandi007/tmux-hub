import { describe, test, expect } from "bun:test";
import {
  buildMenu,
  buildAttachCmd,
  resolveSelection,
  formatMenuItem,
  buildListOutput,
  shouldExec,
} from "../../src/server/hub-tui";
import type { SessionInfo } from "../../src/shared/protocol";

describe("hub-tui pure functions", () => {
  describe("buildMenu", () => {
    test("merges sessions, templates, and new-shell item", () => {
      const sessions: SessionInfo[] = [
        { name: "s1", activity: 100, attached: 0, windows: 1, grammar_ok: true },
        { name: "s2", activity: 200, attached: 1, windows: 2, grammar_ok: true },
      ];
      const templates = [
        { id: "shell", name: "Shell" },
        { id: "dev", name: "Dev" },
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
        { name: "old", activity: 100, attached: 0, windows: 1, grammar_ok: true },
        { name: "new", activity: 300, attached: 0, windows: 1, grammar_ok: true },
        { name: "mid", activity: 200, attached: 0, windows: 1, grammar_ok: true },
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
        { name: "attached", activity: 100, attached: 1, windows: 1, grammar_ok: true },
        { name: "detached", activity: 200, attached: 0, windows: 1, grammar_ok: true },
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
        [{ name: "s1", activity: 100, attached: 0, windows: 1, grammar_ok: true }],
        [],
      );
      const action = resolveSelection(menu, 0);
      expect(action).toEqual({ action: "attach", sessionName: "s1" });
    });

    test("resolves template selection", () => {
      const menu = buildMenu([], [{ id: "shell", name: "Shell" }]);
      const action = resolveSelection(menu, 0);
      expect(action).toEqual({ action: "run-template", templateId: "shell" });
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
        [{ name: "s1", activity: 100, attached: 1, windows: 1, grammar_ok: true }],
        [],
      );
      const formatted = formatMenuItem(menu[0]!);
      expect(formatted).toContain("●");
      expect(formatted).toContain("s1");
    });

    test("formats detached session without marker", () => {
      const menu = buildMenu(
        [{ name: "s1", activity: 100, attached: 0, windows: 1, grammar_ok: true }],
        [],
      );
      const formatted = formatMenuItem(menu[0]!);
      expect(formatted).not.toContain("●");
      expect(formatted).toContain("s1");
    });

    test("formats template with arrow", () => {
      const menu = buildMenu([], [{ id: "shell", name: "Shell" }]);
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
        { name: "s1", activity: 100, attached: 1, windows: 2, grammar_ok: true },
      ];
      const templates = [{ id: "shell", name: "Shell" }];
      const output = buildListOutput(sessions, templates);
      expect(output.sessions).toHaveLength(1);
      expect(output.sessions[0]!.name).toBe("s1");
      expect(output.sessions[0]!.attached).toBe(true);
      expect(output.templates).toHaveLength(1);
      expect(output.templates[0]!.id).toBe("shell");
    });
  });
});
