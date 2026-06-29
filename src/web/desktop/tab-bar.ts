import type { SessionInfo } from "@shared/protocol";
import { isGrammarOk } from "@shared/session-name";
import { showContextMenu } from "../ui/context-menu";
import { showToast } from "../ui/toast";
import { renameSession } from "../shared/rename-controller";
import { imeGuard } from "../shared/ime-guard";
import { getAgentTitleInfo, getAgentStatusIcon } from "../shared/cc-status";

export type TabBarHandle = {
  el: HTMLElement;
  newBtn: HTMLElement;
  refresh: (sessions: SessionInfo[], activeName: string | null) => void;
  setActive: (name: string) => void;
  onSelect: (fn: (name: string) => void) => void;
  onClose: (fn: (name: string) => void) => void;
  onNew: (fn: () => void) => void;
  getSessionAt: (index: number) => string | undefined;
  destroy: () => void;
};

export function createTabBar(parent: HTMLElement): TabBarHandle {
  const el = document.createElement("div");
  el.className = "tab-bar";

  const tabsContainer = document.createElement("div");
  tabsContainer.className = "tab-bar__tabs";

  const newBtn = document.createElement("button");
  newBtn.type = "button";
  newBtn.className = "tab-bar__new";
  newBtn.textContent = "+";
  newBtn.setAttribute("aria-label", "新建会话");

  el.append(tabsContainer, newBtn);
  parent.appendChild(el);

  let selectFn: (name: string) => void = () => {};
  let closeFn: (name: string) => void = () => {};
  let newFn: () => void = () => {};
  let activeName: string | null = null;
  let tabOrder: string[] = [];
  let orderedSessions: SessionInfo[] = [];

  newBtn.addEventListener("click", () => newFn());

  const startEdit = (tab: HTMLElement, sessionName: string): void => {
    const nameEl = tab.querySelector<HTMLElement>(".tab-bar__name");
    if (!nameEl) return;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "tab-bar__rename-input";
    input.value = sessionName;
    input.spellcheck = false;
    input.autocapitalize = "off";
    input.autocomplete = "off";

    let committed = false;
    const cleanup = (): void => {
      nameEl.textContent = sessionName;
      nameEl.style.display = "";
      input.remove();
    };

    const commit = async (): Promise<void> => {
      if (committed) return;
      committed = true;
      const next = input.value.trim();
      if (next === "" || next === sessionName) { cleanup(); return; }
      if (!isGrammarOk(next)) {
        showToast(`名字不合法：${next}（只允许 [a-zA-Z0-9_-]，1-64 字符）`, "error");
        cleanup();
        return;
      }
      try {
        await renameSession(sessionName, next);
      } catch (e) {
        showToast(`重命名失败：${(e as Error).message}`, "error");
        cleanup();
      }
    };

    const ime = imeGuard(input);
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !ime.isComposing()) { e.preventDefault(); void commit(); }
      else if (e.key === "Escape") { e.preventDefault(); committed = true; cleanup(); }
    });
    input.addEventListener("blur", () => { void commit(); });
    input.addEventListener("click", (e) => e.stopPropagation());

    nameEl.style.display = "none";
    nameEl.after(input);
    input.focus();
    input.select();
  };

  const buildTab = (s: SessionInfo, index: number): HTMLElement => {
    const tab = document.createElement("div");
    tab.className = "tab-bar__tab";
    tab.dataset.session = s.name;
    const grammarOk = isGrammarOk(s.name);
    if (!grammarOk) tab.classList.add("is-external");
    if (s.name === activeName) tab.classList.add("is-active");

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "tab-bar__close";
    closeBtn.setAttribute("aria-label", `关闭 ${s.name}`);
    closeBtn.textContent = "×";
    if (grammarOk) {
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        closeFn(s.name);
      });
    } else {
      closeBtn.disabled = true;
    }

    const nameSpan = document.createElement("span");
    nameSpan.className = "tab-bar__name";

    // Agent session: show status icon + task title from pane_title.
    const { status: agentStatus, title: agentTitle } = getAgentTitleInfo(s.name, s.pane_title);
    if (agentStatus !== 'unknown') {
      const statusIcon = document.createElement("span");
      statusIcon.className = `tab-bar__cc-status cc-status--${agentStatus}`;
      statusIcon.textContent = getAgentStatusIcon(agentStatus);
      nameSpan.appendChild(statusIcon);

      const titleText = document.createElement("span");
      titleText.className = "tab-bar__cc-title";
      titleText.textContent = agentTitle;
      nameSpan.appendChild(titleText);
    } else {
      nameSpan.textContent = s.name;
    }

    tab.append(closeBtn, nameSpan);

    if (index < 9) {
      const shortcut = document.createElement("span");
      shortcut.className = "tab-bar__shortcut";
      shortcut.textContent = `⌘${index + 1}`;
      tab.appendChild(shortcut);
    }

    if (grammarOk) {
      tab.addEventListener("click", () => selectFn(s.name));
      tab.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, [
          { label: "编辑名称", action: () => startEdit(tab, s.name) },
          { label: "关闭会话", action: () => closeFn(s.name), danger: true },
        ]);
      });
    }

    return tab;
  };

  const render = (): void => {
    tabsContainer.replaceChildren(
      ...orderedSessions.map((s, i) => buildTab(s, i)),
    );
  };

  const refresh = (sessions: SessionInfo[], active: string | null): void => {
    activeName = active;
    const sessionMap = new Map(sessions.map((s) => [s.name, s]));

    // Remove deleted sessions from tab order
    tabOrder = tabOrder.filter((name) => sessionMap.has(name));

    // Find new sessions not yet in tab order
    const existing = new Set(tabOrder);
    const newSessions = sessions.filter((s) => !existing.has(s.name));

    if (tabOrder.length === 0 && newSessions.length > 0) {
      // First snapshot — sort by activity (most recent first)
      tabOrder = sessions.slice().sort((a, b) => b.activity - a.activity).map((s) => s.name);
    } else {
      // Append new sessions at end
      for (const s of newSessions) tabOrder.push(s.name);
    }

    orderedSessions = tabOrder.map((name) => sessionMap.get(name)!).filter(Boolean);
    render();
  };

  const setActive = (name: string): void => {
    activeName = name;
    for (const child of tabsContainer.children) {
      const tab = child as HTMLElement;
      tab.classList.toggle("is-active", tab.dataset.session === name);
    }
  };

  return {
    el,
    newBtn,
    refresh,
    setActive,
    onSelect: (fn) => { selectFn = fn; },
    onClose: (fn) => { closeFn = fn; },
    onNew: (fn) => { newFn = fn; },
    getSessionAt: (index) => orderedSessions[index]?.name,
    destroy: () => { el.remove(); },
  };
}
