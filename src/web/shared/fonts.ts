// Terminal font stack + webfont preloading.
//
// Order matters: platform-native monospace fonts stay first, so Apple
// platforms keep their exact current look (ui-monospace → SF Mono, then
// Menlo). "Iosevka Term" is our bundled webfont (src/web/fonts/) and only
// catches glyphs the earlier fonts lack — CSS font fallback walks the list
// per glyph. Android resolves neither ui-monospace nor Menlo, so the webfont
// becomes the primary terminal face there, which is the point of the fix:
// its symbols (⏵ U+23F5, → U+2192, box/block elements…) all advance exactly
// one terminal cell, where Android's system fallback either had no glyph at
// all (tofu boxes) or served a full-width one from the CJK font that
// overlapped the next cell. CJK text itself is NOT in the subset and keeps
// falling through to the platform CJK font at double-width, unchanged.
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
    const load = Promise.all([
      document.fonts.load('13px "Iosevka Term"'),
      document.fonts.load('bold 13px "Iosevka Term"'),
    ]).then(
      () => undefined,
      () => undefined,
    );
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2_000));
    fontsPromise = Promise.race([load, timeout]);
  }
  return fontsPromise;
}
