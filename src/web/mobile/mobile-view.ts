import { attachTerminal, type TerminalHandle } from "../terminal";
import { subscribeEvents } from "../sse-client";
import type { SessionInfo, ServerEvent, ClientWsMessage } from "@shared/protocol";
import { isGrammarOk } from "@shared/session-name";
import { renderToolbarKeys } from "./special-keys-bar";
import { renderQuickLaunchButton } from "../shared/template-picker";
import { renderImageAttachButton } from "./image-attach";
import { renderSessionPicker } from "./session-picker";
import { enableWakeLock } from "./wake-lock";
import { showToast, showStickyToast, updateToast, dismissToast } from "../ui/toast";
import { onForegroundAfterIdle } from "../visibility-recovery";
import { createConnectionStatus } from "../ui/connection-status";
import { renameSession } from "../shared/rename-controller";
import { killSession } from "../shared/kill-controller";
import { imeGuard } from "../shared/ime-guard";
import { confirmModal } from "../ui/confirm-modal";
import { saveLastSession, loadLastSession } from "../shared/last-session";
import { createSuggestFlow, type Phase } from "./suggest-flow";
import { getPaneMode, requestSuggestion } from "./suggest-client";
import { renderVoiceButton, type VoiceStatus } from "./voice-input";
import { openVoiceHistory } from "./voice-history";

export function renderMobile(root: HTMLElement): void {
  root.replaceChildren();
  root.className = "mobile-shell";

  enableWakeLock();

  const header = document.createElement("header");
  header.className = "mobile-shell__header";
  root.appendChild(header);

  // 「我的语音历史」入口（账号绑定的语音记录 + 回放）。
  const historyBtn = document.createElement("button");
  historyBtn.type = "button";
  historyBtn.className = "mobile-history-btn";
  historyBtn.setAttribute("aria-label", "我的语音历史");
  historyBtn.textContent = "🎙";
  historyBtn.addEventListener("click", () => openVoiceHistory());
  header.appendChild(historyBtn);

  const termHost = document.createElement("div");
  termHost.className = "mobile-shell__term-host";
  root.appendChild(termHost);

  const connStatus = createConnectionStatus(true);
  connStatus.onRetry(() => { term?.retry(); });
  termHost.appendChild(connStatus.el);

  let term: TerminalHandle | null = null;
  let sessions: SessionInfo[] = [];
  let openedName: string | null = null;

  // NL→command suggest: mode polling state (fail-safe: default other = today's literal-send behaviour).
  let currentMode: "shell" | "other" = "other";
  let suggestEnabled = true;
  let modeTimer: ReturnType<typeof setInterval> | null = null;

  const pollMode = async (): Promise<void> => {
    const name = openedName;
    if (!name) { currentMode = "other"; return; }
    const res = await getPaneMode(name);
    currentMode = res.mode;
    if (!res.enabled) {
      suggestEnabled = false;
      if (modeTimer) { clearInterval(modeTimer); modeTimer = null; }
    }
  };
  modeTimer = setInterval(() => { if (suggestEnabled) void pollMode(); }, 4000);
  void pollMode();

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

      // Re-read pendingTarget: it may have been reassigned during the await above.
      // TypeScript's control flow analysis narrowed it to null after line 55's continue,
      // but that analysis doesn't account for mutations during async operations.
      const recheck = pendingTarget as { name: string; force: boolean } | null;
      if (recheck !== null && recheck.name !== target) {
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

    const ime = imeGuard(input);
    saveBtn.addEventListener("click", () => { void commit(); });
    cancelBtn.addEventListener("click", exitRenameMode);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !ime.isComposing()) { e.preventDefault(); void commit(); }
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
      if (term && e.payload.name === openedName) {
        term.notifySessionActivity(e.payload.attached, e.payload.cols, e.payload.rows);
      }
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
  ta.placeholder = "说点什么…";

  // ⌨ 特殊键面板开关（永远开关，不再兼发送）
  const keysBtn = document.createElement("button");
  keysBtn.type = "button";
  keysBtn.className = "input-bar__keys";
  keysBtn.setAttribute("aria-label", "特殊键");
  keysBtn.setAttribute("aria-expanded", "false");
  keysBtn.textContent = "⌨";

  // ↑ 专用发送（常驻）
  const sendBtn = document.createElement("button");
  sendBtn.type = "button";
  sendBtn.className = "input-bar__send";
  sendBtn.setAttribute("aria-label", "发送");
  sendBtn.textContent = "↑";

  let editing = false;
  let keysOpen = false;

  // AI 介入提示条（默认隐藏，仅 review 态显示）——golden-order：明确提醒有 AI 介入。
  const aiBanner = document.createElement("div");
  aiBanner.className = "input-bar__ai-banner";
  aiBanner.hidden = true;

  const aiLabel = document.createElement("span");
  aiLabel.textContent = "✦ AI 翻译，请核对后再发送";
  aiBanner.appendChild(aiLabel);

  // 撤销按钮（放在 banner 内右侧，仅 review 态显示）。
  const undoBtn = document.createElement("button");
  undoBtn.type = "button";
  undoBtn.className = "input-bar__undo";
  undoBtn.textContent = "↩ 撤销";
  aiBanner.appendChild(undoBtn);

  // textarea 自动撑高：review 态时按内容行数扩展，draft 态恢复单行。
  const autoResize = (): void => {
    ta.style.height = "auto";
    const max = window.innerHeight * 0.4;
    ta.style.height = Math.min(ta.scrollHeight, max) + "px";
  };
  const resetResize = (): void => {
    ta.style.height = "";
  };

  const applyPhase = (phase: Phase): void => {
    inputBar.classList.toggle("is-review", phase === "review");
    inputBar.classList.toggle("is-loading", phase === "loading");
    aiBanner.hidden = phase !== "review";
    ta.readOnly = phase === "loading";
    if (phase === "review") { autoResize(); } else { resetResize(); }
    sendBtn.textContent = phase === "loading" ? "取消" : "↑";
  };

  const flow = createSuggestFlow({
    getText: () => ta.value,
    // 程序化改值不触发 input 事件 → autoResize 不会自动跑；这里显式复位高度，
    // 否则 "other" 模式发送后 setText("") 清空但框还撑着（空框卡高 bug）。
    setText: (s) => { ta.value = s; if (s) autoResize(); else resetResize(); },
    send,
    getSession: () => openedName,
    getMode: () => currentMode,
    requestSuggestion,
    onPhaseChange: applyPhase,
    toast: (m, k) => showToast(m, k ?? "info"),
  });

  const doSend = () => { void flow.primary(); };

  const setEditing = (open: boolean) => {
    editing = open;
    inputBar.classList.toggle("is-editing", open);
    if (open) { if (keysOpen) setKeysPanel(false); ta.focus(); }
    else { ta.blur(); }
  };

  const setKeysPanel = (open: boolean) => {
    keysOpen = open;
    keysPanel.classList.toggle("is-open", open);
    keysBtn.classList.toggle("is-active", open);
    keysBtn.setAttribute("aria-expanded", String(open));
  };

  // pill 容器：暗色圆角，把 📎 / textarea / 🎤 / ↑ 包成一个整体（对齐 todo 结构）。
  const pill = document.createElement("div");
  pill.className = "input-bar__pill";

  const attachBtn = renderImageAttachButton({
    parent: pill,
    getSession: () => openedName,
    getTextarea: () => ta,
    openDrawer: () => setEditing(true),
  });
  attachBtn.className = "input-bar__attach";

  sendBtn.addEventListener("click", () => { doSend(); });
  keysBtn.addEventListener("click", () => { setKeysPanel(!keysOpen); });

  // pill 内顺序：📎(renderImageAttachButton 已 append) → textarea → 🎤 → ↑
  pill.appendChild(ta);

  // 🎤 语音：转写+整理后落框，聚焦待复核（不发送）。renderVoiceButton 内部 append 到 parent。
  renderVoiceButton({
    parent: pill,
    onText: (text) => {
      // 在光标处插入而非覆盖：连续说多段会累加，不会冲掉前一段（沿用 📎 上传的插入写法）。
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? ta.value.length;
      const before = ta.value.slice(0, start);
      const after = ta.value.slice(end);
      const sep = before && !/\s$/.test(before) ? " " : "";
      const ins = sep + text;
      ta.value = before + ins + after;
      setEditing(true);
      const caret = before.length + ins.length;
      ta.setSelectionRange(caret, caret);
      autoResize();
    },
    // 语音状态贯穿录音→转写→整理→完成全程，用单个持久 toast 原地更新文字（不反复弹新窗）。
    // recording/transcribing/cleaning 为进行态，持久显示；idle/error 为终态，更新后淡出。
    onStatus: (() => {
      let voiceToastId: string | null = null;
      // 进行态：有 toast 则原地更新，没有则新建一个持久 toast。
      const live = (msg: string) => {
        if (voiceToastId) updateToast(voiceToastId, msg, "info");
        else voiceToastId = showStickyToast(msg, "info");
      };
      // 终态：更新成最终文案后延时淡出；无 toast 时退化为普通一次性 toast。
      const settle = (msg: string, level: "info" | "error", lingerMs: number) => {
        if (voiceToastId) {
          updateToast(voiceToastId, msg, level);
          const id = voiceToastId;
          voiceToastId = null;
          window.setTimeout(() => dismissToast(id), lingerMs);
        } else showToast(msg, level);
      };
      return (s: VoiceStatus, detail?: string) => {
        if (s === "recording") live(detail ? `🎤 ${detail}` : "🎤 录音中");
        else if (s === "transcribing") live("📝 转写中…");
        else if (s === "cleaning") live("✨ 整理中…");
        else if (s === "idle") {
          if (detail) settle(detail, "info", 2600); // 端到端耗时，看一眼即淡出
          else if (voiceToastId) { dismissToast(voiceToastId); voiceToastId = null; } // 取消（太短）立即收
        } else if (s === "error") settle(detail ?? "⚠️ 出错了", "error", 3200);
      };
    })(),
  });
  pill.appendChild(sendBtn);

  // input bar：AI banner（仅 review 态显示，在 pill 上方）+ pill + 外侧 ⌨。
  inputBar.appendChild(aiBanner);
  inputBar.appendChild(pill);
  inputBar.appendChild(keysBtn);
  undoBtn.addEventListener("click", () => { flow.undo(); ta.focus(); });

  // 输入时实时重算高度：autoResize 先置 auto 再取 scrollHeight，所以既能撑高也能在删字时缩回。
  // 缺这条会导致语音/复核把框撑高后，手动编辑/清空不缩回（变长缩不回去的根因）。
  ta.addEventListener("input", autoResize);
  ta.addEventListener("focus", () => { if (!editing) setEditing(true); });
  ta.addEventListener("blur", () => {
    setTimeout(() => {
      const p = flow.phase();
      if (p === "review" || p === "loading") return; // 复核/思考中不收起
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
