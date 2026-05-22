export function renderMobile(root: HTMLElement): void {
  const el = document.createElement("div");
  el.textContent = "mobile placeholder";
  root.replaceChildren(el);
}
