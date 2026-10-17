import { tmuxOk } from "./tmux-cmd";
import { createLogger } from "./logger";
import { isHubPrivateEnvKey } from "./tmux-env";

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
  await scrubHubPrivateEnv(runner);
}

// A server started by an older hub (or by hand from a hub-spawned shell) still
// carries hub.env in its global env; new sessions would inherit it.
async function scrubHubPrivateEnv(runner: TmuxRunner): Promise<void> {
  const out = await runner(["show-environment", "-g"]);
  const leaked = out.split("\n")
    .map((line) => line.split("=", 1)[0]!)
    .filter((key) => key !== "" && !key.startsWith("-") && isHubPrivateEnvKey(key));
  for (const key of leaked) await runner(["set-environment", "-gu", key]);
  if (leaked.length > 0) logger.info({ keys: leaked }, "scrubbed hub-private keys from tmux global env");
}
