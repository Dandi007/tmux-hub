/**
 * hub TUI — terminal menu for session selection and template launching.
 *
 * Pure functions are exported for unit testing. The CLI entry point lives
 * in bin/tmux-hub (subcommand `tui`).
 */

import type { SessionInfo } from "../shared/protocol";
import { relativeTime } from "../shared/session-name";

// ─── Menu data types ────────────────────────────────────────────────────────

export type MenuItem =
  | { kind: "session"; name: string; attached: boolean; activity: string; raw: SessionInfo }
  | { kind: "template"; id: string; name: string; cwd_choices: string[] }
  | { kind: "new-shell"; name: string };

export interface TemplateSummary {
  id: string;
  name: string;
  /** Allowed working directories (server enforces cwd ∈ cwd_choices). */
  cwd_choices: string[];
}

// ─── Menu assembly (pure) ───────────────────────────────────────────────────

/**
 * Build the merged menu list from sessions and templates.
 * Sessions are sorted by activity descending; attached sessions get a marker.
 * Templates follow sessions. A fixed "new shell" item is appended last.
 */
export function buildMenu(
  sessions: SessionInfo[],
  templates: TemplateSummary[],
): MenuItem[] {
  const items: MenuItem[] = [];

  // Sessions sorted by activity descending
  const sorted = [...sessions].sort((a, b) => b.activity - a.activity);
  for (const s of sorted) {
    items.push({
      kind: "session",
      name: s.name,
      attached: s.attached > 0,
      activity: relativeTime(s.activity),
      raw: s,
    });
  }

  // Templates
  for (const t of templates) {
    items.push({ kind: "template", id: t.id, name: t.name, cwd_choices: t.cwd_choices });
  }

  // Fixed "new shell" item
  items.push({ kind: "new-shell", name: "new shell" });

  return items;
}

/**
 * Format a menu item for display (fzf or numbered list).
 */
export function formatMenuItem(item: MenuItem): string {
  switch (item.kind) {
    case "session": {
      const marker = item.attached ? "●" : " ";
      return `${marker} ${item.name}  [${item.activity}]`;
    }
    case "template":
      return `  ▸ ${item.name} (template: ${item.id})`;
    case "new-shell":
      return `  + new shell`;
  }
}

// ─── Nested command construction (pure) ─────────────────────────────────────

export interface AttachContext {
  /** Value of $TMUX env var (empty or undefined = not inside tmux) */
  tmuxEnv: string;
  /** Target session name */
  target: string;
  /** Whether we're in --loop mode */
  loop: boolean;
  /** Optional tmux socket name (for -L flag) */
  socket?: string;
}

/**
 * Build the argv array to attach/switch to a session.
 *
 * Rules:
 * - $TMUX empty (not inside tmux): `tmux attach -t <name>`
 *   - loop mode: no exec (caller manages loop)
 *   - non-loop: caller should exec
 * - $TMUX non-empty (inside tmux / display-popup): `tmux switch-client -t <name>`
 *   - never attach (nested attach causes errors)
 */
export function buildAttachCmd(ctx: AttachContext): string[] {
  const socketArgs = ctx.socket ? ["-L", ctx.socket] : [];
  const insideTmux = ctx.tmuxEnv.length > 0;

  if (insideTmux) {
    return ["tmux", ...socketArgs, "switch-client", "-t", ctx.target];
  }
  return ["tmux", ...socketArgs, "attach-session", "-t", ctx.target];
}

/**
 * Whether the caller should use exec() (replace process) or spawn() (keep process alive).
 * In loop mode, never exec — the process must survive to return to the menu.
 * Outside tmux and not in loop mode, exec is preferred for clean signal handling.
 */
export function shouldExec(ctx: AttachContext): boolean {
  return !ctx.loop && ctx.tmuxEnv.length === 0;
}

// ─── Selector logic (pure) ──────────────────────────────────────────────────

export type SelectionAction =
  | { action: "attach"; sessionName: string }
  | { action: "run-template"; templateId: string; cwd: string }
  | { action: "new-shell" }
  | { action: "quit" };

/**
 * Parse a selection string (from fzf or numbered input) into an action.
 * The input is the raw selected line text or index.
 *
 * @param items - the menu items array
 * @param selected - the selected item (by index, 0-based)
 */
export function resolveSelection(items: MenuItem[], selected: number): SelectionAction {
  if (selected < 0 || selected >= items.length) {
    return { action: "quit" };
  }
  const item = items[selected]!;
  switch (item.kind) {
    case "session":
      return { action: "attach", sessionName: item.name };
    case "template":
      // cwd_choices is zod-guaranteed min(1); default to the first allowed dir.
      // Hardcoding "~" here was the bug: server rejects cwd ∉ cwd_choices (400).
      return { action: "run-template", templateId: item.id, cwd: item.cwd_choices[0]! };
    case "new-shell":
      return { action: "new-shell" };
  }
}

// ─── fzf detection ──────────────────────────────────────────────────────────

/**
 * Check if fzf is available on PATH.
 *
 * Uses Bun.which (PATH lookup) rather than spawning `command -v fzf` — the
 * latter is a shell builtin and Bun.spawnSync execve's directly, so it would
 * always fail with ENOENT.
 */
export function hasFzf(): boolean {
  return Bun.which("fzf") !== null;
}

/**
 * Run fzf over a list of menu items and return the selected index (or -1 if
 * the user cancelled / fzf exited non-zero). Preview content for session items
 * uses `tmux capture-pane -ep -t <name>`; template items show a cwd/cmd stub.
 *
 * Exported for tests that inject a fake fzf via PATH.
 */
export async function runFzfSelection(
  items: MenuItem[],
  socket?: string,
): Promise<number> {
  const lines = items.map((it) => formatMenuItem(it));
  const input = lines.join("\n") + "\n";

  // Build a preview script: given the selected line, find its index and show
  // context-appropriate preview. Session names are shell-quoted so names with
  // spaces/special chars survive the sh -c round-trip.
  const previewScript = buildFzfPreviewScript(socket);

  const proc = Bun.spawn(
    ["fzf", "--ansi", "--no-sort", "--preview", previewScript],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  // Bun Subprocess stdin is a FileSink (write + end), not a WritableStream
  proc.stdin.write(input);
  proc.stdin.end();

  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) return -1;

  const selected = out.trimEnd();
  const idx = lines.indexOf(selected);
  return idx;
}

function buildFzfPreviewScript(socket?: string): string {
  const sockFlag = socket ? `-L ${shQuote(socket)}` : "";
  // fzf passes the selected line as {}. We match it back to a session name by
  // stripping the leading marker and trailing [relative-time] bracket.
  return `sh -c 'line="$1"; name=$(printf "%s" "$line" | sed -E "s/^[● ] //; s/  \\[.*\\]$//"); case "$line" in "  ▸"*) printf "%s\\n" "(template)" ;; "  +"*) printf "%s\\n" "(new shell)" ;; *) tmux ${sockFlag} capture-pane -ep -t "$name" 2>/dev/null | tail -n 30 ;; esac' _ {}`;
}

// ─── Non-interactive mode helpers ───────────────────────────────────────────

export interface ListOutput {
  sessions: Array<{
    name: string;
    attached: boolean;
    activity: number;
    windows: number;
  }>;
  templates: TemplateSummary[];
}

export function buildListOutput(
  sessions: SessionInfo[],
  templates: TemplateSummary[],
): ListOutput {
  return {
    sessions: sessions.map((s) => ({
      name: s.name,
      attached: s.attached > 0,
      activity: s.activity,
      windows: s.windows,
    })),
    templates,
  };
}

// ─── Shell quoting ──────────────────────────────────────────────────────────

/**
 * Quote a single argv token for safe re-parsing by `sh -c`. Shell-safe tokens
 * (alnum and a few unambiguous punctuation chars) pass through unquoted; all
 * others are wrapped in single quotes with embedded single quotes escaped.
 *
 * Exported for use in bin/tmux-hub --print-cmd output.
 */
export function shQuote(s: string): string {
  if (s.length > 0 && /^[A-Za-z0-9_./:=@%+,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
