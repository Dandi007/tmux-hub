import { createTabBar } from "./tab-bar";
import { createTerminalPool } from "./terminal-pool";
import { renderImageAttachButton } from "../mobile/image-attach";
import { subscribeEvents } from "../sse-client";
import type { SessionInfo, ServerEvent, ClientWsMessage } from "@shared/protocol";
import { isGrammarOk } from "@shared/session-name";
import { confirmModal } from "../ui/confirm-modal";
import { showToast } from "../ui/toast";
import { onForegroundAfterIdle } from "../visibility-recovery";
import { uploadFileForSession } from "../upload/image-upload";
import { createConnectionStatus } from "../ui/connection-status";
import { imeGuard } from "../shared/ime-guard";
import { killSession } from "../shared/kill-controller";
import { saveLastSession, loadLastSession } from "../shared/last-session";
import { openTemplatePicker } from "../shared/template-picker";

export function renderDesktop(root: HTMLElement): void {
  root.replaceChildren();
  root.className = "desktop-shell";

  const tabBar = createTabBar(root);

  const termHost = document.createElement("div");
  termHost.className = "desktop-shell__term-host";
  root.appendChild(termHost);

  const connStatus = createConnectionStatus(false);
  termHost.appendChild(connStatus.el);

  const pool = createTerminalPool(termHost);
  pool.onActiveStateChange((state, attempt) => connStatus.update(state, attempt));
  connStatus.onRetry(() => pool.retryActive());

  let sessions: SessionInfo[] = [];
  let openedName: string | null = null;

  const openSession = (name: string): void => {
    if (!isGrammarOk(name)) return;
    if (name === openedName) return;
    openedName = name;
    pool.activate(name);
    tabBar.setActive(name);
    saveLastSession(name);
  };

  const closeSession = (name: string): void => {
    void confirmModal({
      title: "关闭会话",
      body: `确定要关闭会话「${name}」吗？该会话中的所有进程将被终止。`,
      confirmLabel: "关闭",
      danger: true,
    }).then(async (confirmed) => {
      if (!confirmed) return;
      try {
        await killSession(name);
        showToast(`会话「${name}」已关闭`, "info");
      } catch (e) {
        showToast(`关闭失败：${(e as Error).message}`, "error");
      }
    });
  };

  tabBar.onSelect((name) => openSession(name));
  tabBar.onClose((name) => closeSession(name));
  tabBar.onNew(() => openTemplatePicker({
    anchor: tabBar.newBtn,
    onStarted: (name) => {
      if (sessions.some((s) => s.name === name)) {
        openSession(name);
        return;
      }
      pendingOpen = name;
    },
  }));

  let hasRestoredSession = false;
  let pendingOpen: string | null = null;

  const refreshUI = (): void => {
    tabBar.refresh(sessions, openedName);

    for (const s of sessions) {
      if (isGrammarOk(s.name)) pool.ensure(s.name);
    }

    if (!openedName || !sessions.find((s) => s.name === openedName)) {
      openedName = null;
      const sorted = sessions.slice().sort((a, b) => b.activity - a.activity);
      let target: SessionInfo | undefined;
      if (!hasRestoredSession && sorted.length > 0) {
        hasRestoredSession = true;
        const last = loadLastSession();
        if (last) target = sorted.find((s) => s.name === last && isGrammarOk(s.name));
      }
      if (!target) target = sorted.find((s) => isGrammarOk(s.name));
      if (target) openSession(target.name);
    }
  };

  const sse = subscribeEvents((e: ServerEvent) => {
    if (e.event === "snapshot") {
      sessions = e.payload;
    } else if (e.event === "session_created") {
      sessions = [...sessions, e.payload];
      if (pendingOpen === e.payload.name) {
        pendingOpen = null;
        setTimeout(() => openSession(e.payload.name), 0);
      }
    } else if (e.event === "session_removed") {
      sessions = sessions.filter((s) => s.name !== e.payload.name);
      pool.remove(e.payload.name);
      if (openedName === e.payload.name) openedName = null;
    } else if (e.event === "session_activity") {
      sessions = sessions.map((s) => s.name === e.payload.name ? e.payload : s);
      pool.notifySessionActivity(e.payload.name, e.payload.attached, e.payload.cols, e.payload.rows);
    } else return;
    refreshUI();
  });

  const send = (msg: ClientWsMessage): void => pool.send(msg);

  // Bottom input bar
  const inputBar = document.createElement("div");
  inputBar.className = "mobile-input-bar desktop-input-bar";
  root.appendChild(inputBar);

  const ta = document.createElement("textarea");
  ta.className = "input-bar__textarea";
  ta.rows = 1;
  ta.placeholder = "输入...";

  const doSend = (): void => {
    const text = ta.value;
    if (text) send({ kind: "keys", literal: text });
    send({ kind: "key", name: "Enter" });
    ta.value = "";
  };

  const taIme = imeGuard(ta);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !taIme.isComposing()) {
      e.preventDefault();
      doSend();
    }
  });

  const attachBtn = renderImageAttachButton({
    parent: inputBar,
    getSession: () => openedName,
    getTextarea: () => ta,
    openDrawer: () => ta.focus(),
  });
  attachBtn.className = "input-bar__attach";
  inputBar.appendChild(ta);

  // Paste file in textarea → upload → insert path into textarea
  ta.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const fileItem = Array.from(items).find((it) => it.kind === "file");
    if (!fileItem) return;
    e.preventDefault();
    e.stopPropagation();
    const file = fileItem.getAsFile();
    if (!file || !openedName) return;
    const sessionAtPaste = openedName;
    void (async () => {
      try {
        const path = await uploadFileForSession(sessionAtPaste, file);
        if (openedName !== sessionAtPaste) {
          showToast(`已切到其他 session，文件 ${path} 未注入`, "error");
          return;
        }
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        ta.value = ta.value.substring(0, start) + path + " " + ta.value.substring(end);
        const cursor = start + path.length + 1;
        ta.setSelectionRange(cursor, cursor);
      } catch (err) {
        showToast(`上传失败：${(err as Error).message}`, "error");
      }
    })();
  });

  // Paste file elsewhere (e.g. terminal focused) → upload → send path to terminal
  root.addEventListener("paste", (e) => {
    const items = (e as ClipboardEvent).clipboardData?.items;
    if (!items) return;
    const fileItem = Array.from(items).find((it) => it.kind === "file");
    if (!fileItem) return;
    e.preventDefault();
    e.stopPropagation();
    const file = fileItem.getAsFile();
    if (!file || !openedName) return;
    const sessionAtPaste = openedName;
    void (async () => {
      try {
        const path = await uploadFileForSession(sessionAtPaste, file);
        if (openedName !== sessionAtPaste) {
          showToast(`已切到其他 session，文件 ${path} 未注入`, "error");
        } else {
          pool.send({ kind: "keys", literal: " " + path + " " });
        }
      } catch (err) {
        showToast(`上传失败：${(err as Error).message}`, "error");
      }
    })();
  });

  // Keyboard shortcuts: Ctrl/Cmd+T new / Ctrl/Cmd+W close / Ctrl/Cmd+1-9 switch to the
  // Nth session tab / Ctrl/Cmd+Tab cycle to the next tab. Control is the only modifier
  // that reliably reaches the page on macOS — Chrome reserves Cmd+1-9 for its own
  // browser-tab switching and never delivers those keydowns to a page in a normal tab.
  // We also accept Cmd (harmless, and it works in the installed PWA where Cmd is not
  // reserved), but Ctrl is the guaranteed path.
  //
  // CRITICAL: this listener runs in the CAPTURE phase so it fires BEFORE
  // xterm's textarea keydown handler. In the old bubble-phase wiring xterm
  // had already converted e.g. Ctrl+3 into an ESC byte and shipped it to the
  // PTY (interrupting claude code) by the time this handler ran, so
  // preventDefault was too late. Capturing lets us stopPropagation and keep
  // the chord from ever reaching the terminal.
  const handleShortcuts = (e: KeyboardEvent): void => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    const isDigit = e.key >= "1" && e.key <= "9";

    if (e.key === "t") {
      e.preventDefault();
      e.stopPropagation();
      openTemplatePicker({
        anchor: tabBar.newBtn,
        onStarted: (name) => {
          if (sessions.some((s) => s.name === name)) {
            openSession(name);
            return;
          }
          pendingOpen = name;
        },
      });
    } else if (e.key === "w") {
      e.preventDefault();
      e.stopPropagation();
      if (openedName) closeSession(openedName);
    } else if (isDigit) {
      e.preventDefault();
      e.stopPropagation();
      const name = tabBar.getSessionAt(parseInt(e.key, 10) - 1);
      if (name) openSession(name);
    } else if (e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      const name = openedName ? tabBar.getNextSession(openedName) : undefined;
      if (name) openSession(name);
    }
  };
  document.addEventListener("keydown", handleShortcuts, true);

  onForegroundAfterIdle(3000, () => {
    sse.reconnectIfNeeded();
    pool.probeActive();
  });

  window.__tmuxHub = {
    ...(window.__tmuxHub ?? {}),
    openSession: (name: string) => {
      if (sessions.some((s) => s.name === name)) {
        openSession(name);
      } else {
        pendingOpen = name;
      }
    },
  };
}
