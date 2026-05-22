export type ToastLevel = "info" | "error";

type ToastEntry = {
  id: string;
  el: HTMLElement;
  timer: ReturnType<typeof setTimeout> | null;
};

const active = new Map<string, ToastEntry>();
let nextId = 0;

let root: HTMLElement | null = null;
function ensureRoot(): HTMLElement {
  if (root) return root;
  root = document.getElementById("toast-root") ?? document.body.appendChild(
    Object.assign(document.createElement("div"), { id: "toast-root" }),
  );
  return root;
}

function scheduleDismiss(entry: ToastEntry, duration: number): void {
  if (!Number.isFinite(duration) || duration <= 0) return;
  entry.timer = setTimeout(() => dismissToast(entry.id), duration);
}

function buildToast(message: string, level: ToastLevel): { id: string; entry: ToastEntry } {
  const host = ensureRoot();
  const id = `toast-${++nextId}`;
  const el = document.createElement("div");
  el.className = `toast toast--${level}`;
  el.setAttribute("role", level === "error" ? "alert" : "status");
  el.dataset.toastId = id;
  host.appendChild(el);
  const entry: ToastEntry = { id, el, timer: null };
  active.set(id, entry);
  const body = document.createElement("span");
  body.className = "toast__body";
  body.textContent = message;
  el.appendChild(body);
  return { id, entry };
}

export function showToast(message: string, level: ToastLevel = "info"): string {
  const { id, entry } = buildToast(message, level);
  scheduleDismiss(entry, 3000);
  return id;
}

export type ToastAction = { label: string; onClick: () => void };

export type ShowActionToastOptions = {
  level?: ToastLevel;
  duration?: number;
  action?: ToastAction;
};

export function showActionToast(message: string, opts: ShowActionToastOptions = {}): string {
  const { id, entry } = buildToast(message, opts.level ?? "info");
  if (opts.action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast__action";
    btn.textContent = opts.action.label;
    btn.addEventListener("click", () => {
      try { opts.action!.onClick(); }
      finally { dismissToast(id); }
    });
    entry.el.appendChild(btn);
  }
  scheduleDismiss(entry, opts.duration ?? 6000);
  return id;
}

export function dismissToast(id: string): void {
  const entry = active.get(id);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.el.classList.add("toast--leaving");
  setTimeout(() => {
    entry.el.remove();
    active.delete(id);
  }, 200);
}
