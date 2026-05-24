import pino from "pino";
import { mkdirSync, existsSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";

const LOG_DIR = process.env.TMUX_HUB_LOG_DIR
  ? resolve(process.env.TMUX_HUB_LOG_DIR)
  : resolve(homedir(), ".cache/tmux-hub/logs");

const LOG_FILE = process.env.TMUX_HUB_LOG_FILE
  ?? resolve(LOG_DIR, "server.log");

const LOG_LEVEL = process.env.TMUX_HUB_LOG_LEVEL ?? "info";
const MAX_LOG_BYTES = 50 * 1024 * 1024;

mkdirSync(dirname(LOG_FILE), { recursive: true });

try {
  if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > MAX_LOG_BYTES) {
    renameSync(LOG_FILE, LOG_FILE + ".1");
  }
} catch { /* best-effort rotation */ }

const fileStream = pino.destination({ dest: LOG_FILE, mkdir: true, sync: false });

export const log = pino(
  {
    level: LOG_LEVEL,
    base: { name: "tmux-hub" },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.multistream([
    { stream: process.stderr },
    { stream: fileStream },
  ]),
);

export function createLogger(module: string) {
  return log.child({ module });
}

export { LOG_FILE };

process.on("exit", () => { fileStream.flushSync(); });
