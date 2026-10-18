import { createLogger } from "./logger";
import { tmuxChildEnv } from "./tmux-env";

const logger = createLogger("tmux-cmd");

export type TmuxResult = {
  stdout: string;
  stderr: string;
  code: number;
};

// TMUX_HUB_SOCKET → `-L <name>`（落在按 UID 分的 /tmp/tmux-<uid>/ 下）；
// TMUX_HUB_SOCKET_PATH → `-S <path>`（固定路径，供 sandbox 里 hub 用户连 agent
// 用户的 tmux server）。两者互斥。
export function socketArgs(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const name = env.TMUX_HUB_SOCKET;
  const path = env.TMUX_HUB_SOCKET_PATH;
  if (name && path) {
    throw new Error("TMUX_HUB_SOCKET and TMUX_HUB_SOCKET_PATH are mutually exclusive");
  }
  if (path) return ["-S", path];
  if (name) return ["-L", name];
  return [];
}

export async function tmux(args: string[]): Promise<TmuxResult> {
  const explicit = args.includes("-L") || args.includes("-S");
  const finalArgs = explicit ? args : [...socketArgs(), ...args];
  const proc = Bun.spawn(["tmux", ...finalArgs], {
    stdout: "pipe",
    stderr: "pipe",
    env: tmuxChildEnv(),
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
