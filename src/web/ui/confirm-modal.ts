export type ConfirmOpts = {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
};

export function confirmModal(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    const root = document.getElementById("modal-root") ?? document.body;
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";

    const dialog = document.createElement("div");
    dialog.className = "modal-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");

    const titleEl = document.createElement("h2");
    titleEl.className = "modal-dialog__title";
    titleEl.textContent = opts.title;

    const bodyEl = document.createElement("p");
    bodyEl.className = "modal-dialog__body";
    bodyEl.textContent = opts.body;

    const actions = document.createElement("div");
    actions.className = "modal-dialog__actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = opts.cancelLabel ?? "取消";

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.textContent = opts.confirmLabel;
    if (opts.danger) confirmBtn.classList.add("is-danger");

    actions.append(cancelBtn, confirmBtn);
    dialog.append(titleEl, bodyEl, actions);
    backdrop.appendChild(dialog);
    root.appendChild(backdrop);

    const close = (result: boolean) => {
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
      resolve(result);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(false); }
      else if (e.key === "Enter") { e.preventDefault(); close(true); }
    };
    document.addEventListener("keydown", onKey);

    cancelBtn.addEventListener("click", () => close(false));
    confirmBtn.addEventListener("click", () => close(true));
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(false); });

    confirmBtn.focus();
  });
}
