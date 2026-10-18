// Claude Code 2.1.x keeps its terminal title at "✳ <task>" for the whole turn
// — thinking, streaming and tool execution alike (RSI round 8: 404/404 samples
// over 90s of a working session). The hub read ✳ as "idle" and showed
// 💬 等待输入 while the agent was busy. The reliable signal is the spinner
// status line Claude Code draws above its input box while working.
import { describe, test, expect } from "bun:test";
import { isClaudeWorkingScreen, listSessions } from "../../src/server/session-registry";
import { getAgentStatus } from "../../src/web/shared/cc-status";

const box = ["", "─".repeat(40), "❯ ", "─".repeat(40), "  [Opus 5.5 (1M context)] | repo git:(main)", "  Context 13% | Usage 4%", "  ⏵⏵ bypass permissions on (shift+tab to cycle)"];
const screen = (...above: string[]) => [...above, ...box].join("\n");

describe("isClaudeWorkingScreen", () => {
  test.each([
    "✽ Swooping… (2m 43s · ↓ 2.7k tokens)",
    "✢ Swooping… (1m 15s · ↓ 2.1k tokens · thought for 3s)",
    "· Swooping… (running PostToolUse hooks… 1/2)",
    "* Choreographing… (38s · ↓ 1.8k tokens)",
    "✳ Propagating… (0s · esc to interrupt)",
  ])("working: %s", (line) => {
    expect(isClaudeWorkingScreen(screen("● Running the tests now.", "", line))).toBe(true);
  });

  test.each([
    "✻ Baked for 48s · done 9:36 PM",
    "* Worked for 36s · done 8:16 PM",
    "● Done. All 547 tests pass.",
  ])("idle: %s", (line) => {
    expect(isClaudeWorkingScreen(screen(line))).toBe(false);
  });

  test("a spinner-looking line far above the input box does not count", () => {
    const old = "✽ Swooping… (2m 43s · ↓ 2.7k tokens)";
    const filler = Array.from({ length: 40 }, (_, i) => `output line ${i}`);
    expect(isClaudeWorkingScreen(screen(old, ...filler))).toBe(false);
  });
});

describe("listSessions marks a working Claude Code session", () => {
  const row = (name: string, title: string) => `${name}|$1|1|0|1|200|50|${title}`;
  const fake = (screens: Record<string, string>, calls: string[][]) => async (args: string[]) => {
    calls.push(args);
    if (args[0] === "list-sessions") {
      return { stdout: [row("cc-busy", "✳ Fix the bug"), row("cc-idle", "✳ Claude Code"), row("plain", "zsh")].join("\n"), stderr: "", code: 0 };
    }
    if (args[0] === "capture-pane") {
      const t = args[args.indexOf("-t") + 1]!.replace(/:.*/, "");
      return { stdout: screens[t] ?? "", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };

  test("✳ title + spinner line → working; ✳ without it → idle; non-agent titles are not captured", async () => {
    const calls: string[][] = [];
    const out = await listSessions(fake({
      "cc-busy": screen("✽ Swooping… (2m 43s · ↓ 2.7k tokens)"),
      "cc-idle": screen("✻ Baked for 48s · done 9:36 PM"),
    }, calls) as any);
    const by = Object.fromEntries(out!.map((s) => [s.name, s.pane_title]));
    expect(getAgentStatus(by["cc-busy"]!)).toBe("working");
    expect(by["cc-busy"]!.endsWith("Fix the bug")).toBe(true);
    expect(getAgentStatus(by["cc-idle"]!)).toBe("idle");
    expect(by["plain"]).toBe("zsh");
    const captured = calls.filter((a) => a[0] === "capture-pane").map((a) => a[a.indexOf("-t") + 1]);
    expect(captured.sort()).toEqual(["cc-busy:0.0", "cc-idle:0.0"]);
  });
});
