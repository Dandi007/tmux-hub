/** True when the page was opened with `?debug=<flag>` (comma-list aware, e.g. `?debug=perf,term`). */
export function debugEnabled(flag: string): boolean {
  try {
    const v = new URLSearchParams(location.search).get("debug") ?? "";
    return v.split(",").map((s) => s.trim()).includes(flag);
  } catch {
    return false;
  }
}
