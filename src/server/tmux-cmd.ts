// src/server/tmux-cmd.ts
// Subprocess wrapper for tmux. Talks to the user's default tmux server in production.
// In tests, callers must pass -L <socket> to redirect to an isolated server (enforced by
// tests/helpers/lint-no-default-socket.ts).
export type TmuxResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export async function tmux(args: string[]): Promise<TmuxResult> {
  const proc = Bun.spawn(["tmux", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), code };
}

export async function tmuxOk(args: string[]): Promise<string> {
  const r = await tmux(args);
  if (r.code !== 0) {
    throw new Error(`tmux ${args.join(" ")} failed (${r.code}): ${r.stderr}`);
  }
  return r.stdout;
}
