// Hand an attach's cleanup functions to the ws connection. The ws `close`
// handler runs `unsubs` once; if it already ran while `open` was still awaiting
// (pane pin, broadcaster start, the attach snapshot), anything pushed afterwards
// would never run — a dead subscriber per dropped connection.
export function adoptUnsubs(
  data: { closed?: boolean; unsubs: Array<() => void> },
  ...fns: Array<() => void>
): boolean {
  if (data.closed) {
    for (const fn of fns) try { fn(); } catch {}
    return false;
  }
  data.unsubs.push(...fns);
  return true;
}
