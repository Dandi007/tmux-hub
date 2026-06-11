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
  | { kind: "template"; id: string; name: string }
  | { kind: "new-shell"; name: string };

export interface TemplateSummary {
  id: string;
  name: string;
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
    items.push({ kind: "template", id: t.id, name: t.name });
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
  | { action: "run-template"; templateId: string }
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
      return { action: "run-template", templateId: item.id };
    case "new-shell":
      return { action: "new-shell" };
  }
}

// ─── fzf detection ──────────────────────────────────────────────────────────

/**
 * Check if fzf is available on PATH.
 */
export function hasFzf(): boolean {
  try {
    const r = Bun.spawnSync(["command", "-v", "fzf"]);
    return r.exitCode === 0;
  } catch {
    return false;
  }
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
