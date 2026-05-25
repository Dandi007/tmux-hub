export type ContextMenuItem = {
  label: string;
  action: () => void;
  danger?: boolean;
};

let teardown: (() => void) | null = null;

export function dismissContextMenu(): void {
  if (teardown) { teardown(); teardown = null; }
}

export function showContextMenu(x: number, y: number, items: ContextMenuItem[]): void {
  dismissContextMenu();

  const backdrop = document.createElement("div");
  backdrop.className = "context-menu__backdrop";

  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "context-menu__item";
    if (item.danger) btn.classList.add("is-danger");
    btn.textContent = item.label;
    btn.addEventListener("click", () => {
      dismissContextMenu();
      item.action();
    });
    menu.appendChild(btn);
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") { e.preventDefault(); dismissContextMenu(); }
  };

  backdrop.addEventListener("click", dismissContextMenu);
  backdrop.addEventListener("contextmenu", (e) => { e.preventDefault(); dismissContextMenu(); });
  document.addEventListener("keydown", onKey);

  teardown = () => {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
    menu.remove();
  };

  document.body.append(backdrop, menu);

  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${Math.max(0, window.innerWidth - rect.width - 8)}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${Math.max(0, window.innerHeight - rect.height - 8)}px`;
    }
  });
}
