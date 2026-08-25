import { createTabBar } from "./tab-bar";
import { createTerminalPool } from "./terminal-pool";
import { renderImageAttachButton } from "../mobile/image-attach";
import { renderVoiceButton, type VoiceStatus } from "../mobile/voice-input";
import { openVoiceHistory } from "../mobile/voice-history";
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

  // 语音状态条：flex-wrap 容器内 flex-basis:100% → 独占输入栏首行，隐藏时不占位。
  const voiceStatusRow = document.createElement("div");
  voiceStatusRow.className = "desktop-input-bar__voice-status";
  voiceStatusRow.hidden = true;
  voiceStatusRow.setAttribute("role", "status");
  voiceStatusRow.setAttribute("aria-live", "polite");
  voiceStatusRow.setAttribute("aria-atomic", "true");
  inputBar.appendChild(voiceStatusRow);

  let voiceStatusTimer: number | null = null;

  const showVoiceStatus = (text: string, cls: string, liveMode: "polite" | "assertive" = "polite"): void => {
    voiceStatusRow.className = "desktop-input-bar__voice-status" + (cls ? ` ${cls}` : "");
    voiceStatusRow.setAttribute("aria-live", liveMode);
    voiceStatusRow.textContent = text;
    voiceStatusRow.hidden = false;
  };

  const hideVoiceStatus = (): void => {
    voiceStatusRow.hidden = true;
    voiceStatusRow.textContent = "";
  };

  // 状态文案与移动端 header 状态条同语义；终态延时消失，运行态常驻。
  const setVoiceStatus = (s: VoiceStatus, detail = ""): void => {
    if (voiceStatusTimer !== null) { window.clearTimeout(voiceStatusTimer); voiceStatusTimer = null; }
    const autoHide = (ms: number): void => {
      voiceStatusTimer = window.setTimeout(() => { hideVoiceStatus(); voiceStatusTimer = null; }, ms);
    };
    if (s === "recording") { showVoiceStatus(detail ? `🎤 ${detail}` : "🎤 录音中，再点一次结束", "is-live"); return; }
    if (s === "transcribing") { showVoiceStatus("📝 转写中…", "is-live"); return; }
    if (s === "cleaning") { showVoiceStatus("✨ 整理中…", "is-live"); return; }
    if (s === "idle") {
      if (!detail) { hideVoiceStatus(); return; }
      showVoiceStatus(detail, "");
      autoHide(2600);
      return;
    }
    showVoiceStatus(detail || "⚠️ 出错了", "is-error", "assertive");
    autoHide(3200);
  };

  const attachBtn = renderImageAttachButton({
    parent: inputBar,
    getSession: () => openedName,
    getTextarea: () => ta,
    openDrawer: () => ta.focus(),
  });
  attachBtn.className = "input-bar__attach";
  inputBar.appendChild(ta);

  // 🎤 语音：转写+整理后落框待复核，不自动发送（与移动端同一语义）。
  renderVoiceButton({
    parent: inputBar,
    onText: (text) => {
      // 在光标处插入而非覆盖：连说多段会累加，不会冲掉前一段（沿用 📎 上传的插入写法）。
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? ta.value.length;
      const before = ta.value.slice(0, start);
      const after = ta.value.slice(end);
      const ins = (before && !/\s$/.test(before) ? " " : "") + text;
      ta.value = before + ins + after;
      ta.focus();
      const caret = before.length + ins.length;
      ta.setSelectionRange(caret, caret);
    },
    onStatus: setVoiceStatus,
  });

  // 🕘 我的语音历史（文本 + 原始音频回放）。图标不能再用 🎙：它和录音的 🎤 并排时
  // 就是两个话筒，谁是「录」谁是「历史」全靠猜。
  const voiceHistoryBtn = document.createElement("button");
  voiceHistoryBtn.type = "button";
  voiceHistoryBtn.className = "input-bar__attach";
  voiceHistoryBtn.setAttribute("aria-label", "我的语音历史");
  voiceHistoryBtn.title = "我的语音历史";
  voiceHistoryBtn.textContent = "🕘";
  voiceHistoryBtn.addEventListener("click", () => openVoiceHistory());
  inputBar.appendChild(voiceHistoryBtn);

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
  // Nth session tab / Ctrl/Cmd+Tab cycle to the next tab / Ctrl/Cmd+Shift+Tab cycle
  // to the previous tab. Control is the only modifier that reliably reaches the page
  // on macOS — Chrome reserves Cmd+1-9 for its own browser-tab switching and never
  // delivers those keydowns to a page in a normal tab. We also accept Cmd (harmless,
  // and it works in the installed PWA where Cmd is not reserved), but Ctrl is the
  // guaranteed path.
  //
  // CRITICAL: this listener runs in the CAPTURE phase so it fires BEFORE
  // xterm's textarea keydown handler. In the old bubble-phase wiring xterm
  // had already converted e.g. Ctrl+3 into an ESC byte and shipped it to the
  // PTY (interrupting claude code) by the time this handler ran, so
  // preventDefault was too late. Capturing lets us stopPropagation and keep
  // the chord from ever reaching the terminal.
  const handleShortcuts = (e: KeyboardEvent): void => {
    const isTabChord = e.key === "Tab";
    if (!(e.ctrlKey || e.metaKey) || e.altKey || (e.shiftKey && !isTabChord)) return;
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
      const name = openedName
        ? (e.shiftKey ? tabBar.getPrevSession(openedName) : tabBar.getNextSession(openedName))
        : undefined;
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
