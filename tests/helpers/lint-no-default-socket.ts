// tests/helpers/lint-no-default-socket.ts
// Fails CI if any test code calls tmux without -L (which would hit the user's default socket).
import { Glob } from "bun";
import { readFileSync } from "node:fs";

const SELF_RE = /tests\/helpers\/(tmux-test|lint-no-default-socket)\.ts$/;
const BAD_RE = /\btmux\b(?!-)/; // matches `tmux` not part of e.g. `tmux-cmd`

const glob = new Glob("tests/**/*.{ts,js}");
const offenders: string[] = [];

for await (const file of glob.scan(".")) {
  if (SELF_RE.test(file)) continue;
  const src = readFileSync(file, "utf8");
  // crude scan: each non-comment line containing `tmux` must also contain `-L` or `tmuxTest`/`tmuxTestKillServer`/`tmux-cmd`/`tmux-test`
  src.split("\n").forEach((line, i) => {
    if (line.trim().startsWith("//") || line.trim().startsWith("*")) return;
    if (!BAD_RE.test(line)) return;
    if (
      line.includes("-L") ||
      line.includes("tmuxTest") ||
      line.includes("tmuxTestKillServer") ||
      line.includes("tmux-cmd") ||
      line.includes("tmux-test") ||
      line.includes("import") ||
      line.includes("require")
    ) {
      return;
    }
    offenders.push(`${file}:${i + 1}: ${line.trim()}`);
  });
}

if (offenders.length) {
  console.error("[lint-no-default-socket] forbidden default-tmux-socket usage:");
  for (const o of offenders) console.error("  " + o);
  process.exit(1);
}
console.log("[lint-no-default-socket] OK");
