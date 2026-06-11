import { tmuxOk } from "./tmux-cmd";
import { createLogger } from "./logger";

const logger = createLogger("viewport");

export type TmuxRunner = (args: string[]) => Promise<string>;

export async function getNativeAttachCount(
  session: string,
  runner: TmuxRunner = tmuxOk,
): Promise<number> {
  const out = await runner(["display-message", "-p", "-t", session, "#{session_attached}"]);
  const count = parseInt(out.trim(), 10);
  return Number.isFinite(count) ? count : 0;
}

export async function pinViewport(
  session: string,
  cols: number,
  rows: number,
  runner: TmuxRunner = tmuxOk,
): Promise<void> {
  logger.debug({ session, cols, rows }, "pinning viewport");
  await runner(["set-option", "-t", session, "window-size", "manual"]);
  await runner(["resize-window", "-t", `${session}:0`, "-x", String(cols), "-y", String(rows)]);
}
