import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";

function secretPath(): string {
  return resolve(
    process.env.TMUX_HUB_SECRET_PATH ?? homedir() + "/.config/tmux-hub/hub.secret",
  );
}

export function adminSecretPath(): string {
  return resolve(
    process.env.TMUX_HUB_ADMIN_SECRET_PATH ?? homedir() + "/.config/tmux-hub/hub.admin.secret",
  );
}

export function loadOrCreateSecret(path?: string): string {
  const p = path ?? secretPath();
  if (existsSync(p)) return readFileSync(p, "utf8").trim();
  mkdirSync(dirname(p), { recursive: true });
  const s = randomBytes(32).toString("hex");
  writeFileSync(p, s);
  chmodSync(p, 0o600);
  return s;
}

export function loadOrCreateAdminSecret(): string {
  return loadOrCreateSecret(adminSecretPath());
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
