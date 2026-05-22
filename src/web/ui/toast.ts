export type ToastLevel = "info" | "error";

let root: HTMLElement | null = null;
function ensureRoot(): HTMLElement {
  if (root) return root;
  root = document.getElementById("toast-root") ?? document.body.appendChild(
    Object.assign(document.createElement("div"), { id: "toast-root" }),
  );
  return root;
}

export function showToast(message: string, level: ToastLevel = "info"): void {
  const host = ensureRoot();
  const el = document.createElement("div");
  el.className = `toast toast--${level}`;
  el.setAttribute("role", level === "error" ? "alert" : "status");
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.classList.add("toast--leaving");
    setTimeout(() => el.remove(), 200);
  }, 3000);
}
