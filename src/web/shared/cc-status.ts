/**
 * Claude Code status detection from pane_title.
 *
 * Claude Code updates pane_title with different spinner characters to indicate state:
 * - ✳ = idle (waiting for user input)
 * - ⠐, ⠂, ⠈, ⠠, ⠄, ⠁ (braille spinner) = working (thinking/outputting)
 */

export type CCStatus = 'idle' | 'working' | 'unknown';

/**
 * Detect Claude Code status from pane_title.
 */
export function getClaudeCodeStatus(title: string): CCStatus {
  if (!title) return 'unknown';
  const firstChar = title.charAt(0);

  // ✳ = waiting for user input (idle)
  if (firstChar === '✳') return 'idle';

  // Braille spinner characters = working (thinking/outputting)
  if (/^[⠐⠂⠈⠠⠄⠁]/.test(firstChar)) return 'working';

  return 'unknown';
}

/**
 * Check if pane_title is a Claude Code dynamic task title.
 */
export function isClaudeCodeTitle(title: string): boolean {
  return getClaudeCodeStatus(title) !== 'unknown';
}

/**
 * Get status icon for Claude Code.
 */
export function getCCStatusIcon(status: CCStatus): string {
  switch (status) {
    case 'idle': return '💬';
    case 'working': return '⚡';
    default: return '';
  }
}
