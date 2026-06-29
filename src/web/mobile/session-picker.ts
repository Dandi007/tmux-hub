import type { SessionInfo } from "@shared/protocol";
import { isGrammarOk, formatSessionMeta } from "@shared/session-name";
import { getAgentStatus, getAgentStatusIcon } from "../shared/cc-status";

export type SessionPickerHandle = {
  root: HTMLElement;
  actionRow: HTMLElement;
  refresh: (sessions: SessionInfo[], activeName: string | null) => void;
  setActive: (name: string) => void;
  getValue: () => string | null;
  focus: () => void;
  onKill: ((current: string) => void) | null;
};

export function renderSessionPicker(
  parent: HTMLElement,
  onSelect: (name: string) => void,
): SessionPickerHandle {
  const root = document.createElement("div");
  root.className = "session-picker";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "session-picker__trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");

  const nameSpan = document.createElement("span");
  nameSpan.className = "session-picker__name";
  nameSpan.textContent = "选择会话…";

  const chevron = document.createElement("span");
  chevron.className = "session-picker__chevron";
  chevron.textContent = "▾";

  const killBtn = document.createElement("button");
  killBtn.type = "button";
  killBtn.className = "header-action is-danger";
  killBtn.setAttribute("aria-label", "关闭当前 session");
  killBtn.textContent = "⏻";

  const triggerRow = document.createElement("div");
  triggerRow.className = "session-picker__trigger-row";
  trigger.append(nameSpan, chevron);
  triggerRow.append(trigger, killBtn);
  root.appendChild(triggerRow);

  const backdrop = document.createElement("div");
  backdrop.className = "session-picker__backdrop";

  const dropdown = document.createElement("div");
  dropdown.className = "session-picker__dropdown";
  dropdown.setAttribute("role", "listbox");

  root.append(backdrop, dropdown);
  parent.appendChild(root);

  let isOpen = false;
  let activeName: string | null = null;
  let sessions: SessionInfo[] = [];
  let onKillCb: ((current: string) => void) | null = null;

  killBtn.addEventListener("click", () => {
    if (activeName && onKillCb) onKillCb(activeName);
  });

  const setOpen = (open: boolean) => {
    isOpen = open;
    root.classList.toggle("is-open", open);
    trigger.setAttribute("aria-expanded", String(open));
  };

  trigger.addEventListener("click", () => setOpen(!isOpen));
  backdrop.addEventListener("click", () => setOpen(false));

  const refresh = (newSessions: SessionInfo[], active: string | null) => {
    sessions = newSessions;
    activeName = active;
    const sorted = sessions.slice().sort((a, b) => b.activity - a.activity);

    dropdown.replaceChildren(
      ...sorted.map((s) => {
        const ok = isGrammarOk(s.name);
        const item = document.createElement("button");
        item.type = "button";
        item.className = "session-picker__item";
        item.setAttribute("role", "option");
        item.dataset.session = s.name;
        if (!ok) item.classList.add("is-external");
        if (s.name === active) {
          item.classList.add("is-active");
          item.setAttribute("aria-selected", "true");
        }
        if (!ok) item.disabled = true;

        const n = document.createElement("span");
        n.className = "session-picker__item-name";

        const agentStatus = getAgentStatus(s.pane_title);
        if (agentStatus !== 'unknown') {
          const statusIcon = document.createElement("span");
          statusIcon.className = `session-picker__cc-status cc-status--${agentStatus}`;
          statusIcon.textContent = getAgentStatusIcon(agentStatus);
          n.appendChild(statusIcon);

          const titleText = document.createElement("span");
          titleText.textContent = s.pane_title.substring(1).trim();
          n.appendChild(titleText);
        } else {
          n.textContent = ok ? s.name : `${s.name} (external)`;
        }

        const m = document.createElement("span");
        m.className = "session-picker__item-meta";
        m.textContent = formatSessionMeta(s);

        item.append(n, m);

        item.addEventListener("click", () => {
          if (!ok) return;
          onSelect(s.name);
          setOpen(false);
        });

        return item;
      }),
    );

    if (active) {
      const activeSession = sessions.find((s) => s.name === active);
      const agentStatus = activeSession ? getAgentStatus(activeSession.pane_title) : 'unknown';
      if (agentStatus !== 'unknown' && activeSession) {
        nameSpan.textContent = `${getAgentStatusIcon(agentStatus)} ${activeSession.pane_title.substring(1).trim()}`;
      } else {
        nameSpan.textContent = active;
      }
    }
  };

  const setActive = (name: string) => {
    activeName = name;
    const activeSession = sessions.find((s) => s.name === name);
    const agentStatus = activeSession ? getAgentStatus(activeSession.pane_title) : 'unknown';
    if (agentStatus !== 'unknown' && activeSession) {
      nameSpan.textContent = `${getAgentStatusIcon(agentStatus)} ${activeSession.pane_title.substring(1).trim()}`;
    } else {
      nameSpan.textContent = name;
    }
    for (const item of dropdown.children) {
      const el = item as HTMLElement;
      const isMatch = el.dataset.session === name;
      el.classList.toggle("is-active", isMatch);
      el.setAttribute("aria-selected", String(isMatch));
    }
  };

  return {
    root,
    actionRow: triggerRow,
    refresh,
    setActive,
    getValue: () => activeName,
    focus: () => trigger.focus(),
    get onKill() { return onKillCb; },
    set onKill(fn: ((current: string) => void) | null) { onKillCb = fn; },
  };
}
