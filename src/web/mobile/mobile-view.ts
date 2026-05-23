import { attachTerminal, type TerminalHandle } from "../terminal";
import { subscribeEvents } from "../sse-client";
import type { SessionInfo, ServerEvent, ClientWsMessage } from "@shared/protocol";
import { isGrammarOk } from "@shared/session-name";
import { renderInputBox } from "./input-box";
import { renderSpecialKeysBar } from "./special-keys-bar";
import { renderQuickLaunchButton } from "./quick-launch";
import { renderImageAttachButton } from "./image-attach";
import { showToast } from "../ui/toast";
import { onForegroundAfterIdle } from "../visibility-recovery";
import { renameSession } from "../shared/rename-controller";

export function renderMobile(root: HTMLElement): void {
  root.replaceChildren();
  root.className = "mobile-shell";

  const header = document.createElement("header");
  header.className = "mobile-shell__header";

  const select = document.createElement("select");
  select.className = "mobile-shell__session-select";

  const renameBtn = document.createElement("button");
  renameBtn.type = "button";
  renameBtn.className = "mobile-shell__rename";
  renameBtn.setAttribute("aria-label", "重命名当前 session");
  renameBtn.textContent = "✎";

  header.append(select, renameBtn);
  root.appendChild(header);

  const termHost = document.createElement("div");
  termHost.className = "mobile-shell__term-host";
  root.appendChild(termHost);

  let term: TerminalHandle | null = null;
  let sessions: SessionInfo[] = [];
  let openedName: string | null = null;

  // Pending-target + serial transition queue.
  // Each select-change requests a target session. Only one transition runs
  // at a time; if a new target arrives while a transition is in flight, we
  // overwrite `pendingTarget` and the running loop picks it up after its
  // current attach finishes. This eliminates the overlap window in which
  // two attaches could race and xterm internal state could be torn between
  // dispose and new init.
  type PendingTarget = { name: string; force: boolean } | null;
  let pendingTarget: PendingTarget = null;
  let runningTransition: Promise<void> | null = null;

  const runTransitions = async (): Promise<void> => {
    while (pendingTarget !== null) {
      const { name: target, force } = pendingTarget;
      pendingTarget = null;
      if (!force && target === openedName && term) continue;
      if (!isGrammarOk(target)) continue;

      // Fully tear down the current term BEFORE constructing the new one.
      // The disposed-guard inside terminal.ts now also blocks straggler ws
      // callbacks from writing into the disposed xterm.
      if (term) { try { term.close(); } catch {} term = null; }
      termHost.replaceChildren();
      // Yield to the event loop so any pending ws.onclose / microtask
      // scheduled by the just-torn term drains before we mount the new one.
      await new Promise<void>((r) => setTimeout(r, 0));
      // If another switch came in during the yield, restart with the latest
      // target rather than wasting a connect on the stale one.
      if (pendingTarget !== null) continue;

      openedName = target;
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

      // While we were awaiting attachTerminal a newer pick may have arrived.
      // Discard this attach in favour of the next loop iteration.
      if (pendingTarget !== null && pendingTarget.name !== target) {
        next.close();
        continue;
      }
      term = next;
    }
  };

  const openSession = (name: string, opts?: { force?: boolean }): void => {
    // force=true wins over force=false so a concurrent recovery doesn't
    // get downgraded by a same-target user pick that's still in-queue.
    const prevForce = pendingTarget?.name === name ? pendingTarget.force : false;
    const force = (opts?.force ?? false) || prevForce;
    pendingTarget = { name, force };
    if (!runningTransition) {
      runningTransition = runTransitions().finally(() => {
        runningTransition = null;
      });
    }
  };

  const refreshSelect = () => {
    const sorted = sessions.slice().sort((a, b) => b.activity - a.activity);
    const prevSelected = select.value;
    select.replaceChildren(
      ...sorted.map((s) => {
        const opt = document.createElement("option");
        opt.value = s.name;
        opt.textContent = isGrammarOk(s.name) ? s.name : `${s.name} (external)`;
        if (!isGrammarOk(s.name)) opt.disabled = true;
        return opt;
      }),
    );
    if (prevSelected && sorted.find((s) => s.name === prevSelected)) {
      select.value = prevSelected;
    } else {
      const first = sorted.find((s) => isGrammarOk(s.name));
      if (first && openedName !== first.name) {
        select.value = first.name;
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

    // Replace [select][✎] with [input][保存][取消]
    header.replaceChildren(input, saveBtn, cancelBtn);

    const exitRenameMode = (): void => {
      header.replaceChildren(select, renameBtn);
    };

    const commit = async (): Promise<void> => {
      const next = input.value.trim();
      if (next === "" || next === current) { exitRenameMode(); return; }
      if (!isGrammarOk(next)) {
        showToast(`新名字不合法：${next}（只允许 [a-zA-Z0-9_-]，1-64 字符）`, "error");
        return; // stay in edit mode so user can fix it
      }
      try {
        await renameSession(current, next);
        // SSE session_removed (old) + session_created (new) repaint the select
        // and refreshSelect() picks the new name as current.
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

  renameBtn.addEventListener("click", () => {
    const current = select.value;
    if (!current) return;
    enterRenameMode(current);
  });

  select.addEventListener("change", () => { void openSession(select.value); });

  // Quick-launch: server admits WS attach only after registry poll (≤2s) snapshots
  // the new session. Defer openSession until session_created SSE confirms presence;
  // 5s timeout fallback warns if the event never arrives.
  let pendingQuickLaunchName: string | null = null;
  let pendingQuickLaunchTimer: ReturnType<typeof setTimeout> | null = null;

  const sse = subscribeEvents((e: ServerEvent) => {
    if (e.event === "snapshot") {
      sessions = e.payload;
      // Reconcile any pending quick-launch that arrived in the snapshot
      // (e.g. SSE reconnect after foreground recovery missed the session_created event).
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
    refreshSelect();
  });

  onForegroundAfterIdle(3000, () => {
    sse.reconnectIfNeeded();
    if (openedName !== null && term && !term.isConnected) {
      openSession(openedName, { force: true });
    }
  });

  const send = (msg: ClientWsMessage) => { term?.send(msg); };

  // Collapsible input drawer + toolbar with toggle.
  // Default: drawer hidden so the terminal gets max vertical space and
  // touch scroll has more room to fling. Toggle button at the start of the
  // special-keys row pops the composer up; submit auto-collapses.
  const drawer = document.createElement("div");
  drawer.className = "mobile-drawer";
  const inputForm = renderInputBox(drawer, send);
  root.appendChild(drawer);

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
  // Auto-collapse after submit so the terminal returns to full height.
  inputForm.addEventListener("submit", () => { setDrawer(false); });

  // Mobile quick-launch: one tap → new session from the kb-cc template.
  // Sits between the input drawer toggle (✎) and the special-keys bar.
  renderQuickLaunchButton({
    parent: toolbar,
    onStarted: (name) => {
      // If the session is already in our known list (SSE arrived first), open now.
      if (sessions.some((s) => s.name === name)) {
        openSession(name);
        return;
      }
      // Otherwise queue and wait for session_created SSE (handled above).
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

  renderImageAttachButton({
    parent: toolbar,
    getSession: () => openedName,
    getTextarea: () => drawer.querySelector<HTMLTextAreaElement>(".mobile-input__textarea"),
    openDrawer: () => setDrawer(true),
  });

  renderSpecialKeysBar(toolbar, send);

  // PWA manifest shortcut hooks — see src/web/pwa/shortcuts.ts.
  window.__tmuxHub = {
    ...(window.__tmuxHub ?? {}),
    focusSessionList: () => {
      select.focus();
      select.scrollIntoView({ block: "start", behavior: "smooth" });
    },
    openSession: (name: string) => { void openSession(name); },
  };
}
