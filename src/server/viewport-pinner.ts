import { tmuxOk } from "./tmux-cmd";

export type TmuxRunner = (args: string[]) => Promise<string>;

export async function pinViewport(
  session: string,
  cols: number,
  rows: number,
  runner: TmuxRunner = tmuxOk,
): Promise<void> {
  await runner(["set-option", "-t", session, "window-size", "manual"]);
  await runner(["resize-window", "-t", `${session}:@0`, "-x", String(cols), "-y", String(rows)]);
}
