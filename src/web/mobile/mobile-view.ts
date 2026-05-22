import { attachTerminal, type TerminalHandle } from "../terminal";
import { subscribeEvents } from "../sse-client";
import type { SessionInfo, ServerEvent, ClientWsMessage } from "@shared/protocol";
import { isGrammarOk } from "@shared/session-name";
import { renderInputBox } from "./input-box";
import { renderSpecialKeysBar } from "./special-keys-bar";
import { showToast } from "../ui/toast";

export function renderMobile(root: HTMLElement): void {
  root.replaceChildren();
  root.className = "mobile-shell";

  const header = document.createElement("header");
  header.className = "mobile-shell__header";
  const select = document.createElement("select");
  select.className = "mobile-shell__session-select";
  header.appendChild(select);
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
  let pendingTarget: string | null = null;
  let runningTransition: Promise<void> | null = null;

  const runTransitions = async (): Promise<void> => {
    while (pendingTarget !== null) {
      const target = pendingTarget;
      pendingTarget = null;
      if (target === openedName && term) continue;
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
      if (pendingTarget !== null && pendingTarget !== target) {
        next.close();
        continue;
      }
      term = next;
    }
  };

  const openSession = (name: string): void => {
    pendingTarget = name;
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

  select.addEventListener("change", () => { void openSession(select.value); });

  subscribeEvents((e: ServerEvent) => {
    if (e.event === "snapshot") sessions = e.payload;
    else if (e.event === "session_created") sessions = [...sessions, e.payload];
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
