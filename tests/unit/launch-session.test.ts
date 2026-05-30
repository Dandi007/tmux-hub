import { describe, test, expect } from "bun:test";
import { launchSession, TemplateError, TemplateRunner, formatTs14, buildEnvArgs } from "../../src/server/template-runner";
import type { TmuxRun } from "../../src/server/template-runner";
import type { Template } from "../../src/server/config";

type Call = { args: string[] };
type Scenario = Map<string, { stdout: string; stderr: string; code: number }>;

function mockTmux(scenarios: Scenario): TmuxRun {
  const calls: Call[] = [];
  const fn = async (args: string[]): Promise<{ stdout: string; stderr: string; code: number }> => {
    calls.push({ args: [...args] });
    const key = args.join(" ");
    // Try exact match first, then prefix match
    for (const [pattern, result] of scenarios) {
      if (key.startsWith(pattern)) return { ...result };
    }
    return { stdout: "", stderr: "mock: no scenario", code: 1 };
  };
  (fn as unknown as { calls: Call[] }).calls = calls;
  return fn;
}

describe("launchSession", () => {
  test("creates session with valid inputs", async () => {
    const s = new Map([
      ["has-session -t my-session", { stdout: "", stderr: "", code: 1 }],  // not exists
      ["new-session -d -s my-session -c /tmp", { stdout: "", stderr: "", code: 0 }],
    ]);
    const run = mockTmux(s);
    const name = await launchSession({ name: "my-session", cwd: "/tmp", cmd: "sleep 30", tmuxRun: run });
    expect(name).toBe("my-session");
    const calls = (run as unknown as { calls: Call[] }).calls;
    expect(calls.length).toBe(2);
    expect(calls[0]!.args).toEqual(["has-session", "-t", "my-session"]);
  });

  test("propagates env vars as -e flags", async () => {
    const s = new Map([
      ["has-session -t env-session", { stdout: "", stderr: "", code: 1 }],
      ["new-session -d -s env-session -c /tmp", { stdout: "", stderr: "", code: 0 }],
    ]);
    const run = mockTmux(s);
    await launchSession({ name: "env-session", cwd: "/tmp", cmd: "sleep 30", env: { FOO: "bar" }, tmuxRun: run });
    const calls = (run as unknown as { calls: Call[] }).calls;
    const newSessArgs = calls[1]!.args.join(" ");
    expect(newSessArgs).toContain("-e FOO=bar");
  });

  test("rejects invalid name grammar (400)", async () => {
    const s = new Map();
    const run = mockTmux(s);
    try {
      await launchSession({ name: "Bad.Name!", cwd: "/tmp", cmd: "sleep 30", tmuxRun: run });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(TemplateError);
      expect((e as TemplateError).status).toBe(400);
    }
  });

  test("rejects non-existent cwd (400)", async () => {
    const s = new Map();
    const run = mockTmux(s);
    try {
      await launchSession({ name: "test", cwd: "/this/does/not/exist/at/all", cmd: "sleep 30", tmuxRun: run });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(TemplateError);
      expect((e as TemplateError).status).toBe(400);
    }
  });

  test("rejects duplicate session (409)", async () => {
    const s = new Map([
      ["has-session -t dup", { stdout: "", stderr: "", code: 0 }], // exists
    ]);
    const run = mockTmux(s);
    try {
      await launchSession({ name: "dup", cwd: "/tmp", cmd: "sleep 30", tmuxRun: run });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(TemplateError);
      expect((e as TemplateError).status).toBe(409);
    }
  });

  test("rejects invalid env var name (400)", async () => {
    const s = new Map([
      ["has-session -t test", { stdout: "", stderr: "", code: 1 }],
    ]);
    const run = mockTmux(s);
    try {
      await launchSession({ name: "test", cwd: "/tmp", cmd: "sleep 30", env: { "bad name": "x" }, tmuxRun: run });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(TemplateError);
      expect((e as TemplateError).status).toBe(400);
    }
  });

  test("expands ~ in cwd", async () => {
    // Use a real path to avoid the not-exist guard in launchSession.
    // The expansion logic itself is tested in expand-home.test.ts.
    const s = new Map([
      ["has-session -t home-session", { stdout: "", stderr: "", code: 1 }],
      ["new-session -d -s home-session -c", { stdout: "", stderr: "", code: 0 }],
    ]);
    const run = mockTmux(s);
    await launchSession({ name: "home-session", cwd: "/tmp", cmd: "sleep 30", tmuxRun: run });
    const calls = (run as unknown as { calls: Call[] }).calls;
    // cwd passed to tmux should be the resolved path
    expect(calls[1]!.args).toContain("/tmp");
  });
});

describe("TemplateRunner.run uses launchSession", () => {
  const T: Template[] = [
    { id: "shell", name: "shell", cwd_choices: ["/tmp"], cmd: "sleep 30" },
  ];

  test("creates template session via launchSession", async () => {
    const s = new Map([
      ["has-session -t shell-", { stdout: "", stderr: "", code: 1 }],
      ["new-session -d -s shell-", { stdout: "", stderr: "", code: 0 }],
    ]);
    const run = mockTmux(s);
    const runner = new TemplateRunner(T, run);
    const name = await runner.run("shell", "/tmp");
    expect(name).toMatch(/^shell-\d{14}$/);
  });

  test("rejects cwd not in choices (400)", async () => {
    const s = new Map();
    const run = mockTmux(s);
    const runner = new TemplateRunner(T, run);
    try {
      await runner.run("shell", "/etc");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(TemplateError);
      expect((e as TemplateError).status).toBe(400);
    }
  });
});

describe("formatTs14", () => {
  test("produces 14-char timestamp", () => {
    const ts = formatTs14(new Date("2026-05-30T12:30:45Z"));
    expect(ts).toBe("20260530123045");
  });
});

describe("buildEnvArgs", () => {
  test("creates -e KEY=VAL pairs", () => {
    const args = buildEnvArgs({ FOO: "bar", BAZ: "qux" });
    expect(args).toEqual(["-e", "FOO=bar", "-e", "BAZ=qux"]);
  });

  test("returns empty for undefined env", () => {
    expect(buildEnvArgs(undefined)).toEqual([]);
  });
});