// SGR (1006) mouse-wheel report encoder.
//
// Full-screen TUI apps (claude code, vim, less) run on the alternate screen,
// which has no terminal scrollback — their off-screen content lives inside the
// app. When such an app enables mouse tracking it expects wheel events; we
// translate the mobile touch-drag into these reports so the app scrolls its
// own content (the same thing a real mouse wheel does on desktop).
//
// SGR wheel encoding: ESC [ < <btn> ; <col> ; <row> M
//   btn 64 = wheel up, btn 65 = wheel down. col/row are 1-based cell coords.
// We target SGR (1006) because every modern mouse-mode TUI negotiates it;
// legacy X10/UTF-8 mouse encodings are intentionally unsupported.

export type WheelDirection = "up" | "down";

export function encodeWheel(
  direction: WheelDirection,
  notches: number,
  col: number,
  row: number,
): string {
  const count = Math.floor(notches);
  if (count <= 0) return "";
  const btn = direction === "up" ? 64 : 65;
  const report = `\x1b[<${btn};${col};${row}M`;
  return report.repeat(count);
}
