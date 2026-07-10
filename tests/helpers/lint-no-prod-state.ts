// tests/helpers/lint-no-prod-state.ts
// Fail if test code constructs ManagedSessionDb without an explicit path.
// The bare form resolves to TMUX_HUB_DB_PATH or the user's real
// ~/.cache/tmux-hub/managed-sessions.db — on a production host that opens the
// live db, and a polling SessionRegistry built on top of it can prune live
// session rows (2026-07-10 incident). Always pass a temp path in tests.
import { Glob } from "bun";
import { readFileSync } from "node:fs";

const SELF_RE = /tests\/helpers\/lint-no-prod-state\.ts$/;
const BARE_DB_RE = /new\s+ManagedSessionDb\s*\(\s*\)/;

const glob = new Glob("tests/**/*.{ts,js}");
const offenders: string[] = [];

for await (const file of glob.scan(".")) {
  if (SELF_RE.test(file)) continue;
  const src = readFileSync(file, "utf8");
  src.split("\n").forEach((line, idx) => {
    if (line.trim().startsWith("//") || line.trim().startsWith("*")) return;
    if (BARE_DB_RE.test(line)) offenders.push(`${file}:${idx + 1}: ${line.trim()}`);
  });
}

if (offenders.length) {
  console.error("[lint-no-prod-state] ManagedSessionDb() without explicit path in tests:");
  for (const o of offenders) console.error("  " + o);
  process.exit(1);
}
console.log("[lint-no-prod-state] OK");
