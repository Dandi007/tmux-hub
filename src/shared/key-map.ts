export type KeyEventLike = {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
};

const NAMED: Record<string, string> = {
  Enter: "Enter",
  Escape: "Escape",
  Tab: "Tab",
  Backspace: "BSpace",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Delete: "Delete",
};

export function keyEventToTmuxToken(e: KeyEventLike): string | null {
  if (e.ctrlKey && e.key.length === 1 && /^[a-z]$/i.test(e.key)) {
    return `C-${e.key.toLowerCase()}`;
  }
  return NAMED[e.key] ?? null;
}
