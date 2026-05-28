import { tmuxOk } from "./tmux-cmd";
import { createLogger } from "./logger";

const logger = createLogger("bootstrap");

export type TmuxRunner = (args: string[]) => Promise<string>;

// pinViewport sets per-session window-size=manual so web/mobile clients control the viewport precisely.
// That disables tmux's auto-resize for native terminal clients too, leaving them stuck at whatever
// size the session was last pinned to. These global hooks restore auto-fit for native clients only —
// WebSocket clients don't trigger client-attached/client-resized.
export async function bootstrapTmuxHooks(runner: TmuxRunner = tmuxOk): Promise<void> {
  await runner(["set-hook", "-g", "client-attached", "resize-window -A"]);
  await runner(["set-hook", "-g", "client-resized", "resize-window -A"]);
  logger.info("tmux hooks installed: client-attached/resized → resize-window -A");
}
