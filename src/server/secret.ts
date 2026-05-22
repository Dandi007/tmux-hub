import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";

const PATH = resolve(
  process.env.TMUX_HUB_SECRET_PATH ?? homedir() + "/.config/tmux-hub/hub.secret",
);

export function loadOrCreateSecret(): string {
  if (existsSync(PATH)) return readFileSync(PATH, "utf8").trim();
  mkdirSync(dirname(PATH), { recursive: true });
  const s = randomBytes(32).toString("hex");
  writeFileSync(PATH, s);
  chmodSync(PATH, 0o600);
  return s;
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
