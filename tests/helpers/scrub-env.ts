// tests/helpers/scrub-env.ts
// A shell spawned under a running hub (or with hub.env sourced) carries the
// hub's whole config: prod HOST, voice.db, image dir, suggest/gate credentials.
// Test runs must behave like CI regardless, so drop it all before anything
// reads it. TMUX_HUB_E2E_* is test plumbing set by playwright.config.ts itself.
export function scrubAmbientHubEnv(env: Record<string, string | undefined> = process.env): string[] {
  const removed = Object.keys(env).filter(
    (k) => k.startsWith("GATE_") || (k.startsWith("TMUX_HUB_") && !k.startsWith("TMUX_HUB_E2E_")),
  );
  for (const k of removed) delete env[k];
  return removed;
}
