import { renderSessionList } from "./session-list";
import { renderTemplateDrawer } from "./template-drawer";
import { renderSessionPicker } from "../mobile/session-picker";
import { renderInputBox } from "../mobile/input-box";
import { renderImageAttachButton } from "../mobile/image-attach";
import { attachTerminal, type TerminalHandle } from "../terminal";
import { subscribeEvents } from "../sse-client";
import type { SessionInfo, ServerEvent, ClientWsMessage } from "@shared/protocol";
import { isGrammarOk } from "@shared/session-name";
import { confirmModal } from "../ui/confirm-modal";
import { showToast } from "../ui/toast";
import { hubFetch } from "../hub-fetch";
import { onForegroundAfterIdle } from "../visibility-recovery";
import { uploadImageForSession } from "../upload/image-upload";
import { createConnectionStatus } from "../ui/connection-status";
import { renameSession } from "../shared/rename-controller";
import { killSession } from "../shared/kill-controller";
import { renderQuickLaunchButton } from "../mobile/quick-launch";

export function renderDesktop(root: HTMLElement): void {
  root.replaceChildren();
  root.className = "desktop-shell";

  const header = document.createElement("header");
  header.className = "desktop-shell__header";
  root.appendChild(header);

  const sidebarToggle = document.createElement("button");
  sidebarToggle.type = "button";
  sidebarToggle.className = "desktop-shell__sidebar-toggle";
  sidebarToggle.textContent = "☰";
  sidebarToggle.setAttribute("aria-label", "切换侧边栏");
  header.appendChild(sidebarToggle);

  const sidebarBackdrop = document.createElement("div");
  sidebarBackdrop.className = "desktop-shell__sidebar-backdrop";
  const sidebar = document.createElement("aside");
  sidebar.className = "desktop-shell__sidebar";
  root.append(sidebarBackdrop, sidebar);

  let sidebarOpen = false;
  const setSidebar = (open: boolean) => {
    sidebarOpen = open;
    sidebar.classList.toggle("is-open", open);
    sidebarBackdrop.classList.toggle("is-visible", open);
    sidebarToggle.classList.toggle("is-active", open);
  };
  sidebarToggle.addEventListener("click", () => setSidebar(!sidebarOpen));
  sidebarBackdrop.addEventListener("click", () => setSidebar(false));

  const termHost = document.createElement("div");
  termHost.className = "desktop-shell__term-host";
  root.appendChild(termHost);

  const connStatus = createConnectionStatus(false);
  connStatus.onRetry(() => { term?.retry(); });
  termHost.appendChild(connStatus.el);

  let term: TerminalHandle | null = null;
  let sessions: SessionInfo[] = [];
  let openedName: string | null = null;

  const openSession = async (name: string): Promise<void> => {
    if (name === openedName && term) return;
    if (!isGrammarOk(name)) return;

    if (term) { try { term.close(); } catch {} term = null; }
    termHost.replaceChildren();
    openedName = name;
    picker.setActive(name);
    list.setActive(name);

    try {
      const next = await attachTerminal({ sessionName: name, parent: termHost });
      if (openedName !== name) { next.close(); return; }
      term = next;
      termHost.insertBefore(connStatus.el, termHost.firstChild);
      next.onStateChange((state, attempt) => {
        connStatus.update(state, attempt);
      });
    } catch (e) {
      showToast(`attach 失败: ${(e as Error).message}`, "error");
      openedName = null;
    }
  };

  const picker = renderSessionPicker(header, (name) => {
    void openSession(name);
  });

  let pendingQuickLaunchName: string | null = null;
  let pendingQuickLaunchTimer: ReturnType<typeof setTimeout> | null = null;

  renderQuickLaunchButton({
    parent: picker.actionRow,
    onStarted: (name) => {
      if (sessions.some((s) => s.name === name)) {
        void openSession(name);
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

    header.replaceChildren(sidebarToggle, input, saveBtn, cancelBtn);

    const exitRenameMode = (): void => {
      header.replaceChildren(sidebarToggle, picker.root);
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

  picker.onRename = (current: string) => { enterRenameMode(current); };

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

  const refreshPicker = () => {
    picker.refresh(sessions, openedName);

    if (!openedName || !sessions.find((s) => s.name === openedName)) {
      const sorted = sessions.slice().sort((a, b) => b.activity - a.activity);
      const first = sorted.find((s) => isGrammarOk(s.name));
      if (first) void openSession(first.name);
    }
  };

  const sse = subscribeEvents((e: ServerEvent) => {
    if (e.event === "snapshot") {
      sessions = e.payload;
      if (pendingQuickLaunchName && sessions.some((s) => s.name === pendingQuickLaunchName)) {
        const resolved = pendingQuickLaunchName;
        pendingQuickLaunchName = null;
        if (pendingQuickLaunchTimer) { clearTimeout(pendingQuickLaunchTimer); pendingQuickLaunchTimer = null; }
        void openSession(resolved);
      }
    } else if (e.event === "session_created") {
      sessions = [...sessions, e.payload];
      if (pendingQuickLaunchName === e.payload.name) {
        pendingQuickLaunchName = null;
        if (pendingQuickLaunchTimer) { clearTimeout(pendingQuickLaunchTimer); pendingQuickLaunchTimer = null; }
        void openSession(e.payload.name);
      }
    } else if (e.event === "session_removed") {
      sessions = sessions.filter((s) => s.name !== e.payload.name);
      if (openedName === e.payload.name) {
        openedName = null;
        if (term) { term.close(); term = null; }
      }
    } else if (e.event === "session_activity") {
      sessions = sessions.map((s) => s.name === e.payload.name ? e.payload : s);
    } else return;
    refreshPicker();
  });

  const list = renderSessionList(sidebar);
  list.onSelect((name) => {
    void openSession(name);
    setSidebar(false);
  });
  renderTemplateDrawer(sidebar, (name) => {
    void openSession(name);
    setSidebar(false);
  });

  const send = (msg: ClientWsMessage) => { term?.send(msg); };

  const drawer = document.createElement("div");
  drawer.className = "mobile-drawer";
  const inputForm = renderInputBox(drawer, send);
  root.appendChild(drawer);

  const toolbar = document.createElement("div");
  toolbar.className = "desktop-toolbar";
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

  root.addEventListener("paste", (e) => {
    const items = (e as ClipboardEvent).clipboardData?.items;
    if (!items) return;
    const imageItem = Array.from(items).find((it) => it.type.startsWith("image/"));
    if (!imageItem) return;
    e.preventDefault();
    e.stopPropagation();
    const file = imageItem.getAsFile();
    if (!file || !openedName) return;
    const sessionAtPaste = openedName;
    void (async () => {
      try {
        const path = await uploadImageForSession(sessionAtPaste, file);
        if (openedName !== sessionAtPaste) {
          showToast(`已切到其他 session，图片 ${path} 未注入`, "error");
        } else {
          term?.send({ kind: "keys", literal: " " + path + " " });
        }
      } catch (err) {
        showToast(`上传失败：${(err as Error).message}`, "error");
      }
    })();
  });

  onForegroundAfterIdle(3000, () => {
    sse.reconnectIfNeeded();
    term?.probeNow();
  });

  window.__tmuxHub = {
    ...(window.__tmuxHub ?? {}),
    focusSessionList: () => {
      setSidebar(true);
      const firstItem = sidebar.querySelector<HTMLElement>(".session-list__item");
      firstItem?.scrollIntoView({ block: "start", behavior: "smooth" });
      firstItem?.focus();
    },
    openSession: (name: string) => { void openSession(name); },
  };
}
