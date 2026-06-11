import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SOCKET = `hub-tui-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const TMPDIR = mkdtempSync(join(tmpdir(), "hub-tui-test-"));
const BIN = join(import.meta.dir, "../../bin/tmux-hub");

// Helper to run tmux commands with the same socket the CLI will use
async function tmux(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["tmux", "-L", SOCKET, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}

// Helper to run CLI
async function cli(args: string[], env?: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> {
  // Explicitly unset TMUX unless caller provides it, so tests run outside tmux by default
  const baseEnv: Record<string, string | undefined> = { ...process.env, TMUX_HUB_SOCKET: SOCKET };
  if (!env?.TMUX) {
    delete baseEnv.TMUX;
  }
  const proc = Bun.spawn(["bun", BIN, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...baseEnv, ...env },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}

describe("hub-tui integration", () => {
  beforeAll(async () => {
    // Create a test session
    const r = await tmux(["new-session", "-d", "-s", "test-session", "-c", "/tmp", "sleep 300"]);
    if (r.code !== 0) {
      throw new Error(`failed to create test session: ${r.stderr}`);
    }
  });

  afterAll(async () => {
    // Cleanup
    await tmux(["kill-server"]).catch(() => {});
    try {
      rmSync(TMPDIR, { recursive: true, force: true });
    } catch {}
  });

  test("--list outputs JSON with sessions", async () => {
    const { stdout, code } = await cli(["tui", "--list"]);
    expect(code).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.sessions).toBeArray();
    expect(data.sessions.length).toBeGreaterThan(0);
    const testSession = data.sessions.find((s: any) => s.name === "test-session");
    expect(testSession).toBeDefined();
    expect(testSession.name).toBe("test-session");
  });

  test("--list includes templates array", async () => {
    const { stdout, code } = await cli(["tui", "--list"]);
    expect(code).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.templates).toBeArray();
  });

  test("--select with valid session prints attach command", async () => {
    const { stdout, code } = await cli(["tui", "--select", "test-session", "--print-cmd"]);
    expect(code).toBe(0);
    expect(stdout).toContain("tmux");
    expect(stdout).toContain("attach-session");
    expect(stdout).toContain("test-session");
  });

  test("--select with invalid session exits non-zero", async () => {
    const { code, stderr } = await cli(["tui", "--select", "nonexistent-session", "--print-cmd"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("not found");
  });

  test("--select-template with --dry-run prints POST URL", async () => {
    const { stdout, code } = await cli(["tui", "--select-template", "shell", "--dry-run"]);
    expect(code).toBe(0);
    expect(stdout).toContain("POST");
    expect(stdout).toContain("/templates/shell/run");
  });

  test("nested tmux environment uses switch-client", async () => {
    const { stdout, code } = await cli(
      ["tui", "--select", "test-session", "--print-cmd"],
      { TMUX: "/tmp/tmux-1000/default,12345,0" }
    );
    expect(code).toBe(0);
    expect(stdout).toContain("switch-client");
    expect(stdout).not.toContain("attach-session");
  });

  test("non-nested environment uses attach-session", async () => {
    const { stdout, code } = await cli(
      ["tui", "--select", "test-session", "--print-cmd"],
      { TMUX: "" }
    );
    expect(code).toBe(0);
    expect(stdout).toContain("attach-session");
    expect(stdout).not.toContain("switch-client");
  });

  test("--help shows usage information", async () => {
    const { stdout, code } = await cli(["tui", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("tui");
    expect(stdout).toContain("--list");
    expect(stdout).toContain("--select");
  });

  // PTY attach test is skipped because it requires a real terminal (PTY).
  // In test environments, stdin is a pipe, and `script` fails with:
  // "script: tcgetattr/ioctl: Operation not supported on socket"
  // Bun doesn't have built-in PTY support, so we can't create a real terminal.
  // The attach functionality is tested indirectly via --print-cmd tests.
  test.skip("interactive attach via PTY actually attaches to session", async () => {
    // This test would verify that:
    // 1. CLI spawns tmux attach with correct arguments
    // 2. tmux actually attaches to the session
    // 3. Process stays alive while attached
    // But requires a real PTY which isn't available in test environments.
  });

  test("numbered menu handles 'q' input gracefully", async () => {
    const proc = Bun.spawn(["bun", BIN, "tui"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TMUX_HUB_SOCKET: SOCKET },
    });
    proc.stdin.write("q\n");
    proc.stdin.end();
    const code = await proc.exited;
    expect(code).toBe(0);
  });

  test("numbered menu handles EOF gracefully", async () => {
    const proc = Bun.spawn(["bun", BIN, "tui"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TMUX_HUB_SOCKET: SOCKET },
    });
    proc.stdin.end(); // EOF immediately
    const code = await proc.exited;
    expect(code).toBe(0);
  });
});
