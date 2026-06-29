/**
 * Agent status detection from tmux pane_title.
 *
 * Claude Code and Codex both publish live task titles through terminal title
 * OSC sequences. Claude Code uses ✳ when waiting for input. Both tools use
 * Braille spinner frames while thinking/outputting.
 */

export type AgentStatus = 'idle' | 'working' | 'unknown';
export type CCStatus = AgentStatus;

export type AgentTitleInfo = {
  status: AgentStatus;
  title: string;
};

/**
 * Detect Claude Code / Codex status from pane_title.
 */
export function getAgentStatus(title: string): AgentStatus {
  if (!title) return 'unknown';
  const firstChar = title.charAt(0);

  // ✳ = waiting for user input (idle)
  if (firstChar === '✳') return 'idle';

  // Braille spinner characters = working (thinking/outputting). Codex has
  // been observed using frames such as ⠏ and ⠧, so accept the full block.
  if (/^[\u2800-\u28ff]/.test(firstChar)) return 'working';

  return 'unknown';
}

/**
 * Detect agent status with session-name context. Codex keeps publishing a
 * useful pane_title after the spinner disappears, so codex-named sessions with
 * a non-empty title are treated as idle instead of falling back to session name.
 */
export function getSessionAgentStatus(sessionName: string, title: string): AgentStatus {
  const direct = getAgentStatus(title);
  if (direct !== 'unknown') return direct;
  if (isCodexSessionName(sessionName) && title.trim()) return 'idle';
  return 'unknown';
}

export function getAgentTitleInfo(sessionName: string, title: string): AgentTitleInfo {
  const status = getSessionAgentStatus(sessionName, title);
  if (status === 'unknown') return { status, title: "" };
  return { status, title: stripAgentTitleMarker(title) };
}

function isCodexSessionName(sessionName: string): boolean {
  return /(^|[-_])codex([-_]|$)/i.test(sessionName);
}

function stripAgentTitleMarker(title: string): string {
  if (!title) return "";
  const firstChar = title.charAt(0);
  if (firstChar === '✳' || /^[\u2800-\u28ff]/.test(firstChar)) {
    return title.substring(1).trim();
  }
  return title.trim();
}

/**
 * Backward-compatible name for existing UI code.
 */
export function getClaudeCodeStatus(title: string): CCStatus {
  return getAgentStatus(title);
}

/**
 * Check if pane_title is a dynamic agent task title.
 */
export function isAgentTitle(title: string): boolean {
  return getAgentStatus(title) !== 'unknown';
}

/**
 * Backward-compatible name for existing UI code.
 */
export function isClaudeCodeTitle(title: string): boolean {
  return isAgentTitle(title);
}

/**
 * Get status icon for Claude Code / Codex.
 */
export function getAgentStatusIcon(status: AgentStatus): string {
  switch (status) {
    case 'idle': return '💬';
    case 'working': return '⚡';
    default: return '';
  }
}

/**
 * Backward-compatible name for existing UI code.
 */
export function getCCStatusIcon(status: CCStatus): string {
  return getAgentStatusIcon(status);
}
