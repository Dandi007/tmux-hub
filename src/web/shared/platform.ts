// Platform detection for keyboard-shortcut modifier choices.
// macOS uses Command (metaKey) as the primary app-shortcut modifier and
// reserves Control for terminal control codes; every other platform uses
// Control. navigator.platform is deprecated but still the most reliable
// synchronous signal; fall back to userAgent for good measure.
export const isMac: boolean =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");
