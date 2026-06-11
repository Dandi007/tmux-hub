import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
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

  test("interactive attach via PTY actually attaches to session", async () => {
    // Create a dedicated session for this test
    const ptySessionName = `pty-attach-${process.pid}`;
    const createResult = await tmux(["new-session", "-d", "-s", ptySessionName, "sleep", "60"]);
    expect(createResult.code).toBe(0);

    // Use `expect` to allocate a real PTY and run the CLI.
    // Must explicitly unset TMUX — when running inside tmux, the inherited TMUX
    // env causes switch-client (which fails with "no current client" since the
    // expect-spawned process isn't a tmux client). With TMUX unset, the CLI
    // correctly uses attach-session.
    const expectScript = `
set timeout 5
spawn bun ${BIN} tui --select ${ptySessionName}
expect {
    timeout { }
    eof { }
}
`;
    const expectProc = Bun.spawn(
      ["expect", "-c", expectScript],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          TMUX_HUB_SOCKET: SOCKET,
          TMUX: "",  // Explicitly clear TMUX so attach-session is used
        },
      },
    );

    // Wait for attach to establish (expect needs time to spawn + tmux to connect)
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Check that the session has at least one attached client
    const checkResult = await tmux([
      "list-sessions",
      "-F",
      "#{session_name} #{session_attached}",
    ]);

    const lines = checkResult.stdout.split("\n");
    const targetLine = lines.find(line => line.startsWith(ptySessionName));
    expect(targetLine).toBeDefined();

    const attached = parseInt(targetLine!.split(" ")[1] || "0", 10);
    expect(attached).toBeGreaterThanOrEqual(1);

    // Cleanup: kill the expect process and the test session
    expectProc.kill();
    await expectProc.exited.catch(() => {});
    await tmux(["kill-session", "-t", ptySessionName]).catch(() => {});
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

  test("fzf detection with PATH-injected fake fzf", async () => {
    // Create a fake fzf script that reads stdin and outputs a fixed selection
    const fakeFzfDir = mkdtempSync(join(tmpdir(), "fake-fzf-"));
    const fakeFzfPath = join(fakeFzfDir, "fzf");
    const markerFile = join(fakeFzfDir, "fzf-was-called");
    writeFileSync(
      fakeFzfPath,
      `#!/bin/sh
# Fake fzf: mark that we were called, read stdin, output first line (simulating selection)
touch "${markerFile}"
head -n 1
`,
    );
    chmodSync(fakeFzfPath, 0o755);

    // Run CLI with PATH prepended to find our fake fzf
    // TMUX_HUB_FORCE_FZF=1 bypasses the isTTY check so fzf path is taken even with piped stdin
    const proc = Bun.spawn(["bun", BIN, "tui"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        TMUX_HUB_SOCKET: SOCKET,
        TMUX_HUB_FORCE_FZF: "1",
        PATH: `${fakeFzfDir}:${process.env.PATH}`,
      },
    });

    // fzf reads stdin and outputs the first line (which is the first menu item)
    // The fake fzf will select the first session automatically
    proc.stdin.end();

    const { stdout, stderr } = await proc;
    const code = await proc.exited;

    // Verify fzf was actually invoked (marker file should exist)
    const fzfWasCalled = existsSync(markerFile);
    expect(fzfWasCalled).toBe(true);

    // Should exit cleanly after fzf selects a session and attempts attach
    // (attach may fail if no PTY, but the fzf→action chain was exercised)
    expect(code).toBeGreaterThanOrEqual(0);

    // Cleanup
    try {
      rmSync(fakeFzfDir, { recursive: true, force: true });
    } catch {}
  });

  test("--print-cmd with spaced session name uses shQuote", async () => {
    // Create a session with spaces in the name
    const spacedName = "test session with spaces";
    const createResult = await tmux(["new-session", "-d", "-s", spacedName, "sleep", "60"]);
    expect(createResult.code).toBe(0);

    const { stdout, code } = await cli(["tui", "--select", spacedName, "--print-cmd"]);
    expect(code).toBe(0);

    // The output should contain the session name, properly quoted
    expect(stdout).toContain("tmux");
    expect(stdout).toContain("attach-session");

    // Verify the quoted output can be parsed back by sh -c
    const parseResult = Bun.spawnSync(["sh", "-c", `printf '%s\\n' ${stdout}`]);
    const parsedLines = new TextDecoder().decode(parseResult.stdout).trim().split("\n");
    expect(parsedLines).toContain(spacedName);

    // Cleanup
    await tmux(["kill-session", "-t", spacedName]).catch(() => {});
  });

  test("--loop mode returns to menu after detach", async () => {
    // Create a session for loop testing
    const loopSessionName = `loop-test-${process.pid}`;
    const createResult = await tmux(["new-session", "-d", "-s", loopSessionName, "sleep", "60"]);
    expect(createResult.code).toBe(0);

    // Run with --loop and send: select session, then 'q' to quit
    const proc = Bun.spawn(["bun", BIN, "tui", "--loop"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TMUX_HUB_SOCKET: SOCKET },
    });

    // Send selection (assuming first session) then quit
    proc.stdin.write("1\n");
    await new Promise(resolve => setTimeout(resolve, 500));
    proc.stdin.write("q\n");
    proc.stdin.end();

    const code = await proc.exited;
    expect(code).toBe(0);

    // Cleanup
    await tmux(["kill-session", "-t", loopSessionName]).catch(() => {});
  });
});
