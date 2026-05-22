// tests/helpers/lint-no-default-socket.ts
// Fail if any test code spawns the tmux binary without -L (which would touch the user's
// default tmux server). We restrict to call-site patterns to keep false positives low.
import { Glob } from "bun";
import { readFileSync } from "node:fs";

const SELF_RE = /tests\/helpers\/(tmux-test|lint-no-default-socket)\.ts$/;

// Look for actual spawn-call patterns, not arbitrary occurrences of the word "tmux":
//   - Bun.spawn(["tmux", ...])
//   - spawn(["tmux", ...])
//   - spawnSync(["tmux", ...])
//   - execSync("tmux ...")
//   - exec("tmux ...")
// Each of these forms must contain "-L" within the same statement or be exempt.
const CALL_PATTERNS: RegExp[] = [
  /\bspawn(?:Sync)?\s*\(\s*\[\s*["']tmux["']/, // [...] form
  /\bexec(?:Sync)?\s*\(\s*["']tmux\b/,         // string form
];

const glob = new Glob("tests/**/*.{ts,js}");
const offenders: string[] = [];

for await (const file of glob.scan(".")) {
  if (SELF_RE.test(file)) continue;
  const src = readFileSync(file, "utf8");
  src.split("\n").forEach((line, idx) => {
    if (!CALL_PATTERNS.some((re) => re.test(line))) return;
    if (line.includes("-L")) return;
    offenders.push(`${file}:${idx + 1}: ${line.trim()}`);
  });
}

if (offenders.length) {
  console.error("[lint-no-default-socket] forbidden default-tmux-socket usage:");
  for (const o of offenders) console.error("  " + o);
  process.exit(1);
}
console.log("[lint-no-default-socket] OK");
