// Terminal font stack + webfont preloading.
//
// Order matters: platform-native monospace fonts stay first, so every
// platform keeps its native look for Latin text (SF Mono / Menlo on Apple,
// Roboto Mono via bare `monospace` on Android). "Iosevka Term" is our
// bundled webfont (src/web/fonts/) and is a SYMBOLS-ONLY subset — no
// ASCII/Latin — so it can never take over body text; CSS font fallback walks
// the list per glyph and only reaches it for symbols the system fonts lack
// (⏵ U+23F5, → U+2192, box/block elements…). Those all advance exactly one
// terminal cell, where Android's system fallback either had no glyph at all
// (tofu boxes) or served a full-width one from the CJK font that overlapped
// the next cell. CJK text is not in the subset either and keeps falling
// through to the platform CJK font at double-width, unchanged.
export const TERMINAL_FONT_FAMILY = 'ui-monospace, Menlo, "Iosevka Term", monospace';

let fontsPromise: Promise<void> | null = null;

// Resolve once the bundled webfont is usable, or after a short timeout so a
// slow/offline font fetch can never block attaching a terminal. Callers await
// this BEFORE constructing the xterm Terminal: the canvas renderer rasterizes
// glyphs into a texture atlas on first draw, so cells painted before the font
// arrives would keep their fallback glyphs. (A document.fonts.ready →
// clearTextureAtlas hook in terminal.ts covers the timeout path.)
export function ensureTerminalFonts(): Promise<void> {
  if (!fontsPromise) {
    // Pass sample glyphs the subset actually contains (it has no ASCII), so
    // font matching always intersects the face and triggers the fetch.
    const load = Promise.all([
      document.fonts.load('13px "Iosevka Term"', "⏵→█"),
      document.fonts.load('bold 13px "Iosevka Term"', "⏵→█"),
    ]).then(
      () => undefined,
      () => undefined,
    );
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2_000));
    fontsPromise = Promise.race([load, timeout]);
  }
  return fontsPromise;
}
