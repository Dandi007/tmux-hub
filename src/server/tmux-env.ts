// The tmux server snapshots the environment of whoever starts it into its
// global env, and every session (and so every shell / agent in it) inherits
// that. When the hub starts the server, that would be hub.env: gate signing
// key, API tokens, prod DB paths. So hub-private keys never reach a tmux child.

// Not secrets, and `tmux-hub tui` run inside a session needs them to reach the
// hub that owns the session (dogfood vs prod).
const CLI_ROUTING_KEYS = new Set([
  "TMUX_HUB_SOCKET",
  "TMUX_HUB_PORT",
  "TMUX_HUB_SECRET_PATH",
  "TMUX_HUB_ADMIN_SECRET_PATH",
]);

export function isHubPrivateEnvKey(key: string): boolean {
  if (key.startsWith("GATE_")) return true;
  return key.startsWith("TMUX_HUB_") && !CLI_ROUTING_KEYS.has(key);
}

/**
 * Env for spawning `tmux`. Built from the live process.env on every call —
 * Bun.spawn without `env` uses the startup env and ignores runtime mutations.
 */
export function tmuxChildEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || k === "TMUX" || isHubPrivateEnvKey(k)) continue;
    out[k] = v;
  }
  return out;
}
