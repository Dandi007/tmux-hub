import type { SessionInfo, ServerEvent } from "@shared/protocol";
import { subscribeEvents } from "../sse-client";
import { onForegroundAfterIdle } from "../visibility-recovery";
import { isGrammarOk, formatSessionMeta } from "@shared/session-name";
import { showToast } from "../ui/toast";
import { renameSession } from "../shared/rename-controller";

export type SessionListHandle = {
  el: HTMLElement;
  onSelect: (fn: (name: string) => void) => void;
  setActive: (name: string | null) => void;
  destroy: () => void;
};

export function renderSessionList(parent: HTMLElement): SessionListHandle {
  let sessions: SessionInfo[] = [];
  let selectFn: (name: string) => void = () => {};
  let activeName: string | null = null;
  const el = document.createElement("ul");
  el.className = "session-list";
  parent.appendChild(el);

  const refreshActiveMarker = () => {
    for (const item of el.querySelectorAll<HTMLLIElement>(".session-list__item")) {
      const matches = item.dataset.sessionName === activeName;
      item.classList.toggle("is-active", matches);
      if (matches) item.setAttribute("aria-current", "true");
      else item.removeAttribute("aria-current");
    }
  };

  const buildItem = (s: SessionInfo): HTMLLIElement => {
    const li = document.createElement("li");
    li.className = "session-list__item";
    li.dataset.sessionName = s.name;
    if (s.name === activeName) {
      li.classList.add("is-active");
      li.setAttribute("aria-current", "true");
    }
    const grammarOk = isGrammarOk(s.name);
    if (!grammarOk) li.classList.add("is-external");

    const name = document.createElement("div");
    name.className = "session-list__name";
    name.textContent = s.name;

    const meta = document.createElement("div");
    meta.className = "session-list__meta";
    meta.textContent = formatSessionMeta(s);

    li.append(name, meta);

    if (!grammarOk) {
      const badge = document.createElement("span");
      badge.className = "badge badge--external";
      badge.textContent = "external";
      li.appendChild(badge);
      li.setAttribute("aria-disabled", "true");
    } else {
      // Rename affordance — pencil button reveals an inline <input>.
      const renameBtn = document.createElement("button");
      renameBtn.type = "button";
      renameBtn.className = "session-list__rename";
      renameBtn.title = "重命名";
      renameBtn.setAttribute("aria-label", `重命名 ${s.name}`);
      renameBtn.textContent = "✎";

      const startEdit = (): void => {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "session-list__input";
        input.value = s.name;
        input.spellcheck = false;
        input.autocapitalize = "off";
        input.autocomplete = "off";

        const original = s.name;
        let committed = false;
        const cleanup = (): void => name.replaceChildren(document.createTextNode(original));

        const commit = async (): Promise<void> => {
          if (committed) return;
          committed = true;
          const next = input.value.trim();
          if (next === "" || next === original) { cleanup(); return; }
          if (!isGrammarOk(next)) {
            showToast(`新名字不合法：${next}（只允许 [a-zA-Z0-9_-]，1-64 字符）`, "error");
            cleanup();
            return;
          }
          try {
            await renameSession(original, next);
            // SSE session_removed (old) + session_created (new) will repaint the list.
          } catch (e) {
            showToast(`重命名失败：${(e as Error).message}`, "error");
            cleanup();
          }
        };

        input.addEventListener("keydown", (e) => {
          e.stopPropagation();
          if (e.key === "Enter") { e.preventDefault(); void commit(); }
          else if (e.key === "Escape") { e.preventDefault(); committed = true; cleanup(); }
        });
        input.addEventListener("blur", () => { void commit(); });
        input.addEventListener("click", (e) => e.stopPropagation());

        name.replaceChildren(input);
        input.focus();
        input.select();
      };

      renameBtn.addEventListener("click", (e) => {
        e.stopPropagation();   // do not trigger attach
        startEdit();
      });

      li.appendChild(renameBtn);

      li.tabIndex = 0;
      li.addEventListener("click", () => selectFn(s.name));
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter") selectFn(s.name);
        else if (e.key === "F2") { e.preventDefault(); startEdit(); }
      });
    }
    return li;
  };

  const render = () => {
    el.replaceChildren(
      ...sessions
        .slice()
        .sort((a, b) => b.activity - a.activity)
        .map(buildItem),
    );
  };

  const apply = (e: ServerEvent) => {
    if (e.event === "snapshot") sessions = e.payload;
    else if (e.event === "session_created") sessions = [...sessions, e.payload];
    else if (e.event === "session_removed") sessions = sessions.filter((s) => s.name !== e.payload.name);
    else if (e.event === "session_activity") sessions = sessions.map((s) => s.name === e.payload.name ? e.payload : s);
    else return;
    render();
  };

  const sse = subscribeEvents(apply);
  const cancelRecover = onForegroundAfterIdle(3000, () => sse.reconnectIfNeeded());
  return {
    el,
    onSelect: (fn) => { selectFn = fn; },
    setActive: (name) => {
      activeName = name;
      refreshActiveMarker();
    },
    destroy: () => { cancelRecover(); sse.stop(); el.remove(); },
  };
}
