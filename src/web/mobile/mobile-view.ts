import { attachTerminal, type TerminalHandle } from "../terminal";
import { subscribeEvents } from "../sse-client";
import type { SessionInfo, ServerEvent, ClientWsMessage } from "@shared/protocol";
import { isGrammarOk } from "@shared/session-name";
import { renderInputBox } from "./input-box";
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

  const refreshPicker = () => {
    const sorted = sessions.slice().sort((a, b) => b.activity - a.activity);
    picker.refresh(sessions, openedName);

    if (!openedName || !sorted.find((s) => s.name === openedName)) {
      const first = sorted.find((s) => isGrammarOk(s.name));
      if (first) {
        void openSession(first.name);
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
      if (e.key === "Enter") { e.preventDefault(); void commit(); }
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

  const drawer = document.createElement("div");
  drawer.className = "mobile-drawer";
  const inputForm = renderInputBox(drawer, send);
  root.appendChild(drawer);

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

  // Bottom toolbar: input toggle + image attach + keys grid.
  const toolbar = document.createElement("div");
  toolbar.className = "mobile-toolbar";
  root.appendChild(toolbar);

  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "mobile-toolbar__toggle";
  toggleBtn.setAttribute("aria-expanded", "false");
  toggleBtn.setAttribute("aria-label", "切换多行输入");
  toggleBtn.textContent = "✎";
  toolbar.appendChild(toggleBtn);

  let drawerOpen = false;
  const setDrawer = (open: boolean) => {
    drawerOpen = open;
    drawer.classList.toggle("is-open", open);
    toggleBtn.classList.toggle("is-active", open);
    toggleBtn.setAttribute("aria-expanded", String(open));
    if (open) {
      const ta = drawer.querySelector<HTMLTextAreaElement>(".mobile-input__textarea");
      ta?.focus();
    }
  };
  toggleBtn.addEventListener("click", () => setDrawer(!drawerOpen));
  inputForm.addEventListener("submit", () => { setDrawer(false); });

  renderImageAttachButton({
    parent: toolbar,
    getSession: () => openedName,
    getTextarea: () => drawer.querySelector<HTMLTextAreaElement>(".mobile-input__textarea"),
    openDrawer: () => setDrawer(true),
  });

  renderToolbarKeys(toolbar, send);

  window.__tmuxHub = {
    ...(window.__tmuxHub ?? {}),
    focusSessionList: () => {
      picker.focus();
    },
    openSession: (name: string) => { void openSession(name); },
  };
}
