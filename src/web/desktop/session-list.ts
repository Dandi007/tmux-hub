import type { SessionInfo, ServerEvent } from "@shared/protocol";
import { subscribeEvents } from "../sse-client";
import { isGrammarOk } from "@shared/session-name";

export type SessionListHandle = {
  el: HTMLElement;
  onSelect: (fn: (name: string) => void) => void;
  destroy: () => void;
};

export function renderSessionList(parent: HTMLElement): SessionListHandle {
  let sessions: SessionInfo[] = [];
  let selectFn: (name: string) => void = () => {};
  const el = document.createElement("ul");
  el.className = "session-list";
  parent.appendChild(el);

  const buildItem = (s: SessionInfo): HTMLLIElement => {
    const li = document.createElement("li");
    li.className = "session-list__item";
    const grammarOk = isGrammarOk(s.name);
    if (!grammarOk) li.classList.add("is-external");

    const name = document.createElement("div");
    name.className = "session-list__name";
    name.textContent = s.name;

    const meta = document.createElement("div");
    meta.className = "session-list__meta";
    meta.textContent = `${s.windows}w · ${s.attached}c`;

    li.append(name, meta);

    if (!grammarOk) {
      const badge = document.createElement("span");
      badge.className = "badge badge--external";
      badge.textContent = "external";
      li.appendChild(badge);
      li.setAttribute("aria-disabled", "true");
    } else {
      li.tabIndex = 0;
      li.addEventListener("click", () => selectFn(s.name));
      li.addEventListener("keydown", (e) => { if (e.key === "Enter") selectFn(s.name); });
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

  const unsub = subscribeEvents(apply);
  return {
    el,
    onSelect: (fn) => { selectFn = fn; },
    destroy: () => { unsub(); el.remove(); },
  };
}
