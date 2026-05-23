import { renderSessionList } from "./session-list";
import { renderTemplateDrawer } from "./template-drawer";
import { attachTerminal, type TerminalHandle } from "../terminal";
import { confirmModal } from "../ui/confirm-modal";
import { showToast } from "../ui/toast";
import { hubFetch } from "../hub-fetch";
import { onForegroundAfterIdle } from "../visibility-recovery";
import { uploadImageForSession, IMAGE_ACCEPT_ATTR } from "../upload/image-upload";

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
  let activeName: string | null = null;

  const open = async (name: string) => {
    activeName = null;
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
    const attachBtn = button("📎", "session-header__image-attach");
    attachBtn.setAttribute("aria-label", "上传图片");
    const attachInput = document.createElement("input");
    attachInput.type = "file";
    attachInput.accept = IMAGE_ACCEPT_ATTR;
    attachInput.className = "session-header__image-attach-input";
    attachInput.style.display = "none";
    header.append(nameEl, attachBtn, attachInput, killBtn, refreshBtn, detachBtn);

    const host = document.createElement("div");
    host.className = "session-host";
    right.append(header, host);

    try {
      term = await attachTerminal({ sessionName: name, parent: host });
      activeName = name;
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
      if (r.ok) { activeName = null; }
      else showToast(`kill 失败: ${await r.text()}`, "error");
    });

    refreshBtn.addEventListener("click", async () => {
      const r = await hubFetch(`/sessions/${encodeURIComponent(name)}/refresh`, { method: "POST" });
      if (!r.ok) showToast(`refresh 失败: ${await r.text()}`, "error");
    });

    detachBtn.addEventListener("click", async () => {
      const r = await hubFetch(`/sessions/${encodeURIComponent(name)}/detach`, { method: "POST" });
      if (!r.ok) showToast(`detach 失败: ${await r.text()}`, "error");
    });

    attachBtn.addEventListener("click", () => {
      attachInput.value = "";
      attachInput.click();
    });
    attachInput.addEventListener("change", async () => {
      const file = attachInput.files?.[0];
      if (!file) return;
      attachBtn.disabled = true;
      const original = attachBtn.textContent;
      attachBtn.textContent = "...";
      try {
        const path = await uploadImageForSession(name, file);
        term?.send({ kind: "keys", literal: " " + path + " " });
      } catch (e) {
        showToast(`上传失败：${(e as Error).message}`, "error");
      } finally {
        attachBtn.disabled = false;
        attachBtn.textContent = original;
      }
    });
  };

  list.onSelect((name) => { void open(name); });
  renderTemplateDrawer(left, (name) => { void open(name); });

  onForegroundAfterIdle(3000, () => {
    if (activeName !== null) void open(activeName);
  });

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
