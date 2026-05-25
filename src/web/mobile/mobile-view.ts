import { attachTerminal, type TerminalHandle } from "../terminal";
import { subscribeEvents } from "../sse-client";
import type { SessionInfo, ServerEvent, ClientWsMessage } from "@shared/protocol";
import { isGrammarOk } from "@shared/session-name";
import { renderToolbarKeys } from "./special-keys-bar";
import { renderQuickLaunchButton } from "./quick-launch";
import { renderImageAttachButton } from "./image-attach";
import { renderSessionPicker } from "./session-picker";
import { enableWakeLock } from "./wake-lock";
import { showToast } from "../ui/toast";
import { onForegroundAfterIdle } from "../visibility-recovery";
import { createConnectionStatus } from "../ui/connection-status";
import { renameSession } from "../shared/rename-controller";
import { killSession } from "../shared/kill-controller";
import { confirmModal } from "../ui/confirm-modal";
import { saveLastSession, loadLastSession } from "../shared/last-session";

export function renderMobile(root: HTMLElement): void {
  root.replaceChildren();
  root.className = "mobile-shell";

  enableWakeLock();

  const header = document.createElement("header");
  header.className = "mobile-shell__header";
  root.appendChild(header);

  const termHost = document.createElement("div");
  termHost.className = "mobile-shell__term-host";
  root.appendChild(termHost);

  const connStatus = createConnectionStatus(true);
  connStatus.onRetry(() => { term?.retry(); });
  termHost.appendChild(connStatus.el);

  let term: TerminalHandle | null = null;
  let sessions: SessionInfo[] = [];
  let openedName: string | null = null;

  type PendingTarget = { name: string; force: boolean } | null;
  let pendingTarget: PendingTarget = null;
  let runningTransition: Promise<void> | null = null;

  const runTransitions = async (): Promise<void> => {
    while (pendingTarget !== null) {
      const { name: target, force } = pendingTarget;
      pendingTarget = null;
      if (!force && target === openedName && term) continue;
      if (!isGrammarOk(target)) continue;

      if (term) { try { term.close(); } catch {} term = null; }
      termHost.replaceChildren();
      await new Promise<void>((r) => setTimeout(r, 0));
      if (pendingTarget !== null) continue;

      openedName = target;
      picker.setActive(target);
      let next: TerminalHandle | null = null;
      try {
        next = await attachTerminal({ sessionName: target, parent: termHost, readOnly: true });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[tmux-hub] attach failed for", target, msg);
        showToast(`attach 失败: ${msg}`, "error");
        openedName = null;
        continue;
      }

      if (pendingTarget !== null && pendingTarget.name !== target) {
        next.close();
        continue;
      }
      term = next;
      next.onStateChange((state, attempt) => {
        connStatus.update(state, attempt);
      });
    }
  };

  const openSession = (name: string, opts?: { force?: boolean }): void => {
    saveLastSession(name);
    const prevForce = pendingTarget?.name === name ? pendingTarget.force : false;
    const force = (opts?.force ?? false) || prevForce;
    pendingTarget = { name, force };
    if (!runningTransition) {
      runningTransition = runTransitions().finally(() => {
        runningTransition = null;
      });
    }
  };

  const picker = renderSessionPicker(header, (name) => {
    void openSession(name);
  });

  let hasRestoredSession = false;

  const refreshPicker = () => {
    const sorted = sessions.slice().sort((a, b) => b.activity - a.activity);
    picker.refresh(sessions, openedName);

    if (!openedName || !sorted.find((s) => s.name === openedName)) {
      let target: SessionInfo | undefined;
      if (!hasRestoredSession && sorted.length > 0) {
        hasRestoredSession = true;
        const last = loadLastSession();
        if (last) target = sorted.find((s) => s.name === last && isGrammarOk(s.name));
      }
      if (!target) target = sorted.find((s) => isGrammarOk(s.name));
      if (target) {
        void openSession(target.name);
      }
    }
  };

  const enterRenameMode = (current: string): void => {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "mobile-shell__rename-input";
    input.value = current;
    input.spellcheck = false;
    input.autocapitalize = "off";
    input.autocomplete = "off";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "mobile-shell__rename-save";
    saveBtn.textContent = "保存";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "mobile-shell__rename-cancel";
    cancelBtn.textContent = "取消";

    header.replaceChildren(input, saveBtn, cancelBtn);

    const exitRenameMode = (): void => {
      header.replaceChildren(picker.root);
    };

    const commit = async (): Promise<void> => {
      const next = input.value.trim();
      if (next === "" || next === current) { exitRenameMode(); return; }
      if (!isGrammarOk(next)) {
        showToast(`新名字不合法：${next}（只允许 [a-zA-Z0-9_-]，1-64 字符）`, "error");
        return;
      }
      try {
        await renameSession(current, next);
        exitRenameMode();
      } catch (e) {
        showToast(`重命名失败：${(e as Error).message}`, "error");
      }
    };

    saveBtn.addEventListener("click", () => { void commit(); });
    cancelBtn.addEventListener("click", exitRenameMode);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); void commit(); }
      else if (e.key === "Escape") { e.preventDefault(); exitRenameMode(); }
    });

    setTimeout(() => { input.focus(); input.select(); }, 0);
  };

  picker.onRename = (current: string) => {
    enterRenameMode(current);
  };

  picker.onKill = (current: string) => {
    void confirmModal({
      title: "关闭会话",
      body: `确定要关闭会话「${current}」吗？该会话中的所有进程将被终止。`,
      confirmLabel: "关闭",
      danger: true,
    }).then(async (confirmed) => {
      if (!confirmed) return;
      try {
        await killSession(current);
        showToast(`会话「${current}」已关闭`, "info");
      } catch (e) {
        showToast(`关闭失败：${(e as Error).message}`, "error");
      }
    });
  };

  let pendingQuickLaunchName: string | null = null;
  let pendingQuickLaunchTimer: ReturnType<typeof setTimeout> | null = null;

  const sse = subscribeEvents((e: ServerEvent) => {
    if (e.event === "snapshot") {
      sessions = e.payload;
      if (pendingQuickLaunchName !== null && sessions.some((s) => s.name === pendingQuickLaunchName)) {
        const resolvedName = pendingQuickLaunchName;
        pendingQuickLaunchName = null;
        if (pendingQuickLaunchTimer) { clearTimeout(pendingQuickLaunchTimer); pendingQuickLaunchTimer = null; }
        openSession(resolvedName);
      }
    }
    else if (e.event === "session_created") {
      sessions = [...sessions, e.payload];
      if (pendingQuickLaunchName === e.payload.name) {
        pendingQuickLaunchName = null;
        if (pendingQuickLaunchTimer) { clearTimeout(pendingQuickLaunchTimer); pendingQuickLaunchTimer = null; }
        openSession(e.payload.name);
      }
    }
    else if (e.event === "session_removed") {
      sessions = sessions.filter((s) => s.name !== e.payload.name);
      if (openedName === e.payload.name) {
        openedName = null;
        if (term) { term.close(); term = null; }
      }
    } else if (e.event === "session_activity") {
      sessions = sessions.map((s) => s.name === e.payload.name ? e.payload : s);
    } else {
      return;
    }
    refreshPicker();
  });

  onForegroundAfterIdle(3000, () => {
    sse.reconnectIfNeeded();
    term?.probeNow();
  });

  const send = (msg: ClientWsMessage) => { term?.send(msg); };

  // Quick-launch (+) goes in header alongside session picker.
  renderQuickLaunchButton({
    parent: picker.actionRow,
    onStarted: (name) => {
      if (sessions.some((s) => s.name === name)) {
        openSession(name);
        return;
      }
      pendingQuickLaunchName = name;
      if (pendingQuickLaunchTimer) clearTimeout(pendingQuickLaunchTimer);
      pendingQuickLaunchTimer = setTimeout(() => {
        if (pendingQuickLaunchName === name) {
          pendingQuickLaunchName = null;
          pendingQuickLaunchTimer = null;
          showToast(`新建会话 ${name} 等待超时，请手动从列表选择`, "error");
        }
      }, 5000);
    },
  });

  // Keys panel (collapsible, opens when + is tapped)
  const keysPanel = document.createElement("div");
  keysPanel.className = "mobile-keys-panel";
  renderToolbarKeys(keysPanel, send);
  root.appendChild(keysPanel);

  // Bottom input bar: [📎] [textarea (inline expand)] [+/发送]
  const inputBar = document.createElement("div");
  inputBar.className = "mobile-input-bar";
  root.appendChild(inputBar);

  const ta = document.createElement("textarea");
  ta.className = "input-bar__textarea";
  ta.rows = 1;
  ta.placeholder = "输入...";

  const rightBtn = document.createElement("button");
  rightBtn.type = "button";
  rightBtn.className = "input-bar__expand";
  rightBtn.setAttribute("aria-label", "展开键盘");
  rightBtn.textContent = "+";

  let editing = false;
  let keysOpen = false;

  const doSend = () => {
    const text = ta.value;
    if (text) send({ kind: "keys", literal: text });
    send({ kind: "key", name: "Enter" });
    ta.value = "";
    setEditing(false);
  };

  const setEditing = (open: boolean) => {
    editing = open;
    inputBar.classList.toggle("is-editing", open);
    if (open) {
      if (keysOpen) setKeysPanel(false);
      rightBtn.textContent = "发送";
      rightBtn.className = "input-bar__send";
      rightBtn.setAttribute("aria-label", "发送");
      ta.focus();
    } else {
      ta.blur();
      rightBtn.textContent = "+";
      rightBtn.className = "input-bar__expand";
      rightBtn.setAttribute("aria-label", "展开键盘");
    }
  };

  const setKeysPanel = (open: boolean) => {
    keysOpen = open;
    keysPanel.classList.toggle("is-open", open);
    rightBtn.classList.toggle("is-active", open);
    rightBtn.setAttribute("aria-expanded", String(open));
  };

  const attachBtn = renderImageAttachButton({
    parent: inputBar,
    getSession: () => openedName,
    getTextarea: () => ta,
    openDrawer: () => setEditing(true),
  });
  attachBtn.className = "input-bar__attach";

  inputBar.appendChild(ta);

  rightBtn.addEventListener("click", () => {
    if (editing) {
      doSend();
    } else {
      setKeysPanel(!keysOpen);
    }
  });
  inputBar.appendChild(rightBtn);

  ta.addEventListener("focus", () => { if (!editing) setEditing(true); });
  ta.addEventListener("blur", () => {
    setTimeout(() => {
      if (!inputBar.contains(document.activeElement)) setEditing(false);
    }, 150);
  });

  window.__tmuxHub = {
    ...(window.__tmuxHub ?? {}),
    focusSessionList: () => {
      picker.focus();
    },
    openSession: (name: string) => { void openSession(name); },
  };
}
