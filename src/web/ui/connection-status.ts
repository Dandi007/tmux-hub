import type { TerminalState } from "../terminal";

export type ConnectionStatusHandle = {
  el: HTMLElement;
  update: (state: TerminalState, attempt?: number) => void;
  onRetry: (cb: () => void) => void;
  destroy: () => void;
};

export function createConnectionStatus(isMobile: boolean): ConnectionStatusHandle {
  const el = document.createElement("div");
  el.className = "connection-status";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.hidden = true;

  const label = document.createElement("span");
  label.className = "connection-status__label";
  el.appendChild(label);

  const retryBtn = document.createElement("button");
  retryBtn.type = "button";
  retryBtn.className = "connection-status__retry";
  retryBtn.hidden = true;
  retryBtn.textContent = isMobile ? "tap to retry" : "click to retry";
  el.appendChild(retryBtn);

  let retryCb: (() => void) | null = null;
  retryBtn.addEventListener("click", () => { retryCb?.(); });

  const update = (state: TerminalState, attempt?: number): void => {
    if (state === "connected") {
      el.hidden = true;
      el.classList.remove("is-dead");
      return;
    }
    el.hidden = false;
    if (state === "reconnecting") {
      el.classList.remove("is-dead");
      retryBtn.hidden = true;
      label.textContent = `reconnecting… (attempt ${attempt ?? "?"}/${8})`;
    } else {
      el.classList.add("is-dead");
      retryBtn.hidden = false;
      label.textContent = "connection lost — ";
    }
  };

  return {
    el,
    update,
    onRetry: (cb) => { retryCb = cb; },
    destroy: () => { el.remove(); },
  };
}
