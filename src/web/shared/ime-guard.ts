/**
 * Chrome fires a second keydown (Enter, isComposing=false) right after
 * compositionend. A plain `!e.isComposing` check lets it through.
 * This helper tracks composition state with a delayed clear so the
 * phantom Enter is blocked.
 */
export function imeGuard(el: HTMLElement): { isComposing: () => boolean } {
  let composing = false;
  el.addEventListener("compositionstart", () => { composing = true; });
  el.addEventListener("compositionend", () => {
    setTimeout(() => { composing = false; }, 0);
  });
  return { isComposing: () => composing };
}
