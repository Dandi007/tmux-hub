import { createLogger } from "./logger";

const logger = createLogger("tmux-cmd");

export type TmuxResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export async function tmux(args: string[]): Promise<TmuxResult> {
  const socket = process.env.TMUX_HUB_SOCKET;
  const finalArgs = socket && !args.includes("-L") ? ["-L", socket, ...args] : args;
  const proc = Bun.spawn(["tmux", ...finalArgs], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  logger.trace({ args: finalArgs, code }, "tmux exec");
  return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), code };
}

export async function tmuxOk(args: string[]): Promise<string> {
  const r = await tmux(args);
  if (r.code !== 0) {
    throw new Error(`tmux ${args.join(" ")} failed (${r.code}): ${r.stderr}`);
  }
  return r.stdout;
}
