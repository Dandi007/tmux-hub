// Manifest shortcuts wiring.
//
// The PWA manifest exposes two right-click Dock shortcuts:
//   - /?action=new-session   → spawn a fresh zsh session via /templates/<id>/run
//   - /?focus=session-list   → emphasize the session list panel
//
// To keep view modules decoupled from the bootstrap, each view registers an
// imperative handler on `window.__tmuxHub.{focusSessionList,openSession}`.
// The bootstrap reads `URLSearchParams` once and replays whichever applies.
//
// We strip the shortcut params from the URL after applying so a refresh
// inside the PWA window doesn't re-trigger the action.

import { hubFetch } from "../hub-fetch";
import { showToast } from "../ui/toast";

type TemplateDTO = { id: string; name: string; cwd_choices: string[] };

declare global {
  interface Window {
    __tmuxHub?: {
      focusSessionList?: () => void;
      openSession?: (name: string) => void;
    };
  }
}

export function focusSessionList(): void {
  const hook = window.__tmuxHub?.focusSessionList;
  if (typeof hook === "function") {
    try { hook(); } catch (e) { console.warn("[PWA] focusSessionList failed:", e); }
    return;
  }
  const list = document.querySelector<HTMLElement>(".session-list, .mobile-session-list");
  if (list) {
    list.scrollIntoView({ behavior: "smooth", block: "start" });
    const first = list.querySelector<HTMLElement>("button, [tabindex]");
    first?.focus();
  }
}

async function findZshTemplate(): Promise<TemplateDTO | null> {
  const r = await hubFetch("/templates");
  if (!r.ok) return null;
  const templates = (await r.json()) as TemplateDTO[];
  if (!Array.isArray(templates) || templates.length === 0) return null;
  return (
    templates.find((t) => t.id === "shell") ??
    templates.find((t) => /zsh|shell/i.test(t.name)) ??
    templates[0] ??
    null
  );
}

export async function requestNewZshSession(): Promise<void> {
  try {
    const template = await findZshTemplate();
    if (!template) {
      showToast("没有可用模板，无法新建 session", "error");
      return;
    }
    const cwd = template.cwd_choices[0] ?? "~";
    const r = await hubFetch(`/templates/${encodeURIComponent(template.id)}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => r.statusText);
      showToast(`新建 session 失败: ${text}`, "error");
      return;
    }
    const body = (await r.json()) as { name: string };
    window.__tmuxHub?.openSession?.(body.name);
    showToast(`已创建 session ${body.name}`, "info");
  } catch (e) {
    showToast(`新建 session 出错: ${(e as Error).message}`, "error");
  }
}

export type LaunchActionHandlers = {
  onNewSession?: () => void;
  onFocusList?: () => void;
};

export function applyLaunchQueryActions(handlers: LaunchActionHandlers): void {
  try {
    const params = new URLSearchParams(window.location.search);
    const action = params.get("action");
    const focus = params.get("focus");
    if (action === "new-session" && handlers.onNewSession) handlers.onNewSession();
    if (focus === "session-list" && handlers.onFocusList) handlers.onFocusList();
    if (action || focus) {
      params.delete("action");
      params.delete("focus");
      const qs = params.toString();
      const url = window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
      window.history.replaceState(null, "", url);
    }
  } catch (e) {
    console.warn("[PWA] applyLaunchQueryActions failed:", e);
  }
}
