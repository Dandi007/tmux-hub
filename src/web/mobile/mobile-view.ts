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
  let attachSeq = 0;

  const openSession = async (name: string) => {
    if (!isGrammarOk(name)) return;
    if (openedName === name && term) return;
    if (term) { term.close(); term = null; }
    // Wipe the host before attaching the next terminal. xterm.dispose() does
    // not always clear leftover canvas/viewport nodes — without this, on iOS
    // Safari the new xterm mounts behind the stale one and the user sees a
    // blank session ("没加载"). Desktop view does the same.
    termHost.replaceChildren();
    openedName = name;
    attachSeq += 1;
    const myAttach = attachSeq;
    try {
      const next = await attachTerminal({ sessionName: name, parent: termHost, readOnly: true });
      if (myAttach !== attachSeq) {
        // A newer attach won the race — discard ours so we don't leak xterms.
        next.close();
        return;
      }
      term = next;
    } catch (e) {
      openedName = null;
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[tmux-hub] attach failed for", name, msg);
      showToast(`attach 失败: ${msg}`, "error");
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
  renderInputBox(root, send);
  renderSpecialKeysBar(root, send);

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
