// tests/helpers/tmux-test.ts
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmuxTmpdir: string | null = null;
let socketName: string | null = null;

export function setupIsolatedTmux(): { socket: string; tmpdir: string } {
  if (socketName && tmuxTmpdir) return { socket: socketName, tmpdir: tmuxTmpdir };
  tmuxTmpdir = mkdtempSync(join("/tmp", "tht-"));
  process.env.TMUX_TMPDIR = tmuxTmpdir;
  socketName = `hub-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  return { socket: socketName, tmpdir: tmuxTmpdir };
}

export async function tmuxTest(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const { socket, tmpdir: sockDir } = setupIsolatedTmux();
  // Explicit env is REQUIRED: Bun.spawn without `env` inherits the process's
  // STARTUP environment and silently drops runtime process.env mutations, so
  // the TMUX_TMPDIR set in setupIsolatedTmux never reached the child and test
  // sockets landed in the ambient (possibly production) socket dir. TMUX is
  // dropped so running the suite from inside a tmux session behaves the same
  // as running it outside one.
  const env: Record<string, string | undefined> = { ...process.env, TMUX_TMPDIR: sockDir };
  delete env.TMUX;
  const proc = Bun.spawn(["tmux", "-L", socket, ...args], { stdout: "pipe", stderr: "pipe", env });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), code };
}

export async function tmuxTestKillServer(): Promise<void> {
  if (!socketName) return;
  await tmuxTest(["kill-server"]).catch(() => {});
  if (tmuxTmpdir && existsSync(tmuxTmpdir)) {
    try { rmSync(tmuxTmpdir, { recursive: true, force: true }); } catch {}
  }
  socketName = null;
  tmuxTmpdir = null;
}
