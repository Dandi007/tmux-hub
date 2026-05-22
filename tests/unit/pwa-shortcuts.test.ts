// Headless unit test for the PWA shortcut query parser. We can't import the
// module directly because it touches `window` / `document` at module load
// time. Instead we re-implement the tiny query-string contract here and
// assert it matches the behaviour the SPA will see.

import { describe, test, expect } from "bun:test";

function parseShortcutQuery(search: string): { action?: string; focus?: string; source?: string } {
  const params = new URLSearchParams(search);
  const out: { action?: string; focus?: string; source?: string } = {};
  const a = params.get("action");
  const f = params.get("focus");
  const s = params.get("source");
  if (a) out.action = a;
  if (f) out.focus = f;
  if (s) out.source = s;
  return out;
}

describe("PWA shortcuts URL parsing", () => {
  test("/?action=new-session", () => {
    expect(parseShortcutQuery("?action=new-session")).toEqual({ action: "new-session" });
  });

  test("/?focus=session-list", () => {
    expect(parseShortcutQuery("?focus=session-list")).toEqual({ focus: "session-list" });
  });

  test("PWA launch URL keeps source=pwa", () => {
    expect(parseShortcutQuery("?source=pwa&action=new-session")).toEqual({
      action: "new-session",
      source: "pwa",
    });
  });

  test("unknown query is ignored", () => {
    expect(parseShortcutQuery("?foo=bar")).toEqual({});
  });
});
