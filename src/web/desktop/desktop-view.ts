export function renderDesktop(root: HTMLElement): void {
  const el = document.createElement("div");
  el.textContent = "desktop placeholder";
  root.replaceChildren(el);
}
