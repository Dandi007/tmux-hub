import type { SessionInfo } from "@shared/protocol";
import { isGrammarOk } from "@shared/session-name";

function relativeTime(ts: number): string {
  const delta = Math.floor((Date.now() - ts * 1000) / 1000);
  if (delta < 60) return "刚刚";
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  return `${Math.floor(delta / 86400)}d`;
}

export type SessionPickerHandle = {
  root: HTMLElement;
  actionRow: HTMLElement;
  refresh: (sessions: SessionInfo[], activeName: string | null) => void;
  setActive: (name: string) => void;
  getValue: () => string | null;
  focus: () => void;
  onRename: ((current: string) => void) | null;
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

  const renameBtn = document.createElement("button");
  renameBtn.type = "button";
  renameBtn.className = "session-picker__rename";
  renameBtn.setAttribute("aria-label", "重命名当前 session");
  renameBtn.textContent = "✎";

  const triggerRow = document.createElement("div");
  triggerRow.className = "session-picker__trigger-row";
  trigger.append(nameSpan, chevron);
  triggerRow.append(trigger, renameBtn);
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
  let onRenameCb: ((current: string) => void) | null = null;

  renameBtn.addEventListener("click", () => {
    if (activeName && onRenameCb) onRenameCb(activeName);
  });

  const setOpen = (open: boolean) => {
    isOpen = open;
    root.classList.toggle("is-open", open);
    trigger.setAttribute("aria-expanded", String(open));
  };

  trigger.addEventListener("click", () => setOpen(!isOpen));
  backdrop.addEventListener("click", () => setOpen(false));

  const refresh = (sessions: SessionInfo[], active: string | null) => {
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
        n.textContent = ok ? s.name : `${s.name} (external)`;

        const m = document.createElement("span");
        m.className = "session-picker__item-meta";
        m.textContent = relativeTime(s.activity);

        item.append(n, m);

        item.addEventListener("click", () => {
          if (!ok) return;
          onSelect(s.name);
          setOpen(false);
        });

        return item;
      }),
    );

    if (active) nameSpan.textContent = active;
  };

  const setActive = (name: string) => {
    activeName = name;
    nameSpan.textContent = name;
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
    get onRename() { return onRenameCb; },
    set onRename(fn: ((current: string) => void) | null) { onRenameCb = fn; },
  };
}
