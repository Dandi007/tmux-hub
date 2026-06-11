/**
 * CLI argument parsing for bin/tmux-hub.
 * Exported for unit testing — bin/tmux-hub imports from here.
 */

export interface LaunchArgs {
  cwd: string;
  cmd: string;
  name?: string;
  env: Record<string, string>;
}

export interface TuiArgs {
  /** Print menu as JSON and exit (non-interactive) */
  list: boolean;
  /** Select a session by name (non-interactive) */
  select?: string;
  /** Select a template by id (non-interactive) */
  selectTemplate?: string;
  /** Print the attach command instead of executing it */
  printCmd: boolean;
  /** Dry run: don't actually POST to server */
  dryRun: boolean;
  /** Loop mode: return to menu after detach */
  loop: boolean;
}

type ParseResult = { ok: true; value: LaunchArgs } | { ok: false; error: string };
type TuiParseResult = { ok: true; value: TuiArgs } | { ok: false; error: string };

export function parseLaunchArgs(argv: string[]): ParseResult {
  if (argv.length < 1 || argv[0] !== "launch") {
    return { ok: false, error: "expected 'launch' subcommand" };
  }

  let i = 1;
  let cwd = "";
  let name: string | undefined;
  const env: Record<string, string> = {};

  while (i < argv.length && argv[i] !== "--") {
    const a = argv[i]!;
    if (a === "--cwd") {
      i++;
      if (i >= argv.length) return { ok: false, error: "--cwd requires a value" };
      cwd = argv[i]!;
    } else if (a.startsWith("--cwd=")) {
      cwd = a.slice("--cwd=".length);
    } else if (a === "--name") {
      i++;
      if (i >= argv.length) return { ok: false, error: "--name requires a value" };
      name = argv[i]!;
    } else if (a.startsWith("--name=")) {
      name = a.slice("--name=".length);
    } else if (a === "--env") {
      i++;
      if (i >= argv.length) return { ok: false, error: "--env requires KEY=VAL" };
      const kv = argv[i]!;
      const split = kv.indexOf("=");
      if (split < 1) return { ok: false, error: `invalid env: ${kv} (expected KEY=VAL)` };
      env[kv.slice(0, split)] = kv.slice(split + 1);
    } else if (a.startsWith("--env=")) {
      const kv = a.slice("--env=".length);
      const split = kv.indexOf("=");
      if (split < 1) return { ok: false, error: `invalid env: ${kv} (expected KEY=VAL)` };
      env[kv.slice(0, split)] = kv.slice(split + 1);
    } else {
      return { ok: false, error: `unknown flag: ${a}` };
    }
    i++;
  }

  if (i >= argv.length || argv[i] !== "--") {
    return { ok: false, error: "missing -- before command" };
  }
  i++;

  if (i >= argv.length) {
    return { ok: false, error: "missing <cmd...> after --" };
  }
  if (!cwd) {
    return { ok: false, error: "--cwd is required" };
  }

  // The server runs `cmd` as a single string via `sh -c`, so we must shell-quote
  // each command word before joining — a plain join(" ") loses argv word
  // boundaries (e.g. `bash -c 'echo hi; sleep 5'` would collapse so `bash -c echo`
  // runs echo with no args). Minimal quoting: leave shell-safe tokens bare for
  // readability, single-quote anything else so `sh -c "$cmd"` reproduces argv.
  const cmd = argv.slice(i).map(shQuote).join(" ");
  const result: LaunchArgs = { cwd, cmd, env };
  if (name) result.name = name;

  return { ok: true, value: result };
}

export function parseTuiArgs(argv: string[]): TuiParseResult {
  if (argv.length < 1 || argv[0] !== "tui") {
    return { ok: false, error: "expected 'tui' subcommand" };
  }

  const result: TuiArgs = {
    list: false,
    printCmd: false,
    dryRun: false,
    loop: false,
  };

  let i = 1;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === "--list") {
      result.list = true;
    } else if (a === "--select") {
      i++;
      if (i >= argv.length) return { ok: false, error: "--select requires a value" };
      result.select = argv[i]!;
    } else if (a.startsWith("--select=")) {
      result.select = a.slice("--select=".length);
    } else if (a === "--select-template") {
      i++;
      if (i >= argv.length) return { ok: false, error: "--select-template requires a value" };
      result.selectTemplate = argv[i]!;
    } else if (a.startsWith("--select-template=")) {
      result.selectTemplate = a.slice("--select-template=".length);
    } else if (a === "--print-cmd") {
      result.printCmd = true;
    } else if (a === "--dry-run") {
      result.dryRun = true;
    } else if (a === "--loop") {
      result.loop = true;
    } else if (a === "--help" || a === "-h") {
      // Help is handled by the caller
      return { ok: false, error: "help requested" };
    } else {
      return { ok: false, error: `unknown flag: ${a}` };
    }
    i++;
  }

  // Validation
  if (result.select && result.selectTemplate) {
    return { ok: false, error: "--select and --select-template are mutually exclusive" };
  }
  if (result.dryRun && !result.selectTemplate) {
    return { ok: false, error: "--dry-run only applies to --select-template" };
  }

  return { ok: true, value: result };
}

// Quote a single argv token for safe re-parsing by `sh -c`. Shell-safe tokens
// (alnum and a few unambiguous punctuation chars) pass through unquoted; all
// others are wrapped in single quotes with embedded single quotes escaped.
function shQuote(s: string): string {
  if (s.length > 0 && /^[A-Za-z0-9_./:=@%+,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}