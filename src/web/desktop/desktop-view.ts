import { renderSessionList } from "./session-list";
import { renderTemplateDrawer } from "./template-drawer";
import { attachTerminal, type TerminalHandle } from "../terminal";
import { confirmModal } from "../ui/confirm-modal";
import { showToast } from "../ui/toast";
import { hubFetch } from "../hub-fetch";

function button(label: string, extraClass = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (extraClass) b.className = extraClass;
  return b;
}

export function renderDesktop(root: HTMLElement): void {
  root.replaceChildren();
  root.className = "desktop-shell";

  const left = document.createElement("aside");
  left.className = "desktop-shell__sidebar";
  const right = document.createElement("main");
  right.className = "desktop-shell__main";
  root.append(left, right);

  const list = renderSessionList(left);
  let term: TerminalHandle | null = null;

  const open = async (name: string) => {
    if (term) { term.close(); term = null; }
    list.setActive(name);
    right.replaceChildren();

    const header = document.createElement("header");
    header.className = "session-header";
    const nameEl = document.createElement("strong");
    nameEl.textContent = name;
    const killBtn = button("kill", "is-danger");
    const refreshBtn = button("refresh");
    const detachBtn = button("detach");
    header.append(nameEl, killBtn, refreshBtn, detachBtn);

    const host = document.createElement("div");
    host.className = "session-host";
    right.append(header, host);

    try {
      term = await attachTerminal({ sessionName: name, parent: host });
    } catch (e) {
      showToast(`attach 失败: ${(e as Error).message}`, "error");
      return;
    }

    killBtn.addEventListener("click", async () => {
      const ok = await confirmModal({
        title: `kill ${name}?`,
        body: "这会直接终止该 session 内运行的 agent 进程。确认继续？",
        confirmLabel: "kill",
        danger: true,
      });
      if (!ok) return;
      const r = await hubFetch(`/sessions/${encodeURIComponent(name)}/kill`, {
        method: "POST",
        headers: { "X-Hub-Confirm": "kill" },
      });
      if (!r.ok) showToast(`kill 失败: ${await r.text()}`, "error");
    });

    refreshBtn.addEventListener("click", async () => {
      const r = await hubFetch(`/sessions/${encodeURIComponent(name)}/refresh`, { method: "POST" });
      if (!r.ok) showToast(`refresh 失败: ${await r.text()}`, "error");
    });

    detachBtn.addEventListener("click", async () => {
      const r = await hubFetch(`/sessions/${encodeURIComponent(name)}/detach`, { method: "POST" });
      if (!r.ok) showToast(`detach 失败: ${await r.text()}`, "error");
    });
  };

  list.onSelect((name) => { void open(name); });
  renderTemplateDrawer(left, (name) => { void open(name); });

  // Expose imperative hooks for PWA manifest shortcuts. Bootstrap reads
  // ?action=new-session / ?focus=session-list and calls into these.
  window.__tmuxHub = {
    ...(window.__tmuxHub ?? {}),
    focusSessionList: () => {
      const firstItem = left.querySelector<HTMLElement>(".session-list__item");
      firstItem?.scrollIntoView({ block: "start", behavior: "smooth" });
      firstItem?.focus();
    },
    openSession: (name: string) => { void open(name); },
  };
}
