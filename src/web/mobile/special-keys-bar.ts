import type { ClientWsMessage } from "@shared/protocol";

const FUNC_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["Esc", "Escape"],
  ["Tab", "Tab"],
  ["^C", "C-c"],
  ["^D", "C-d"],
  ["^Z", "C-z"],
];

const ARROW_KEYS: ReadonlyArray<readonly [label: string, name: string, cls: string]> = [
  ["↑", "Up", "arrow-up"],
  ["←", "Left", "arrow-left"],
  ["↓", "Down", "arrow-down"],
  ["→", "Right", "arrow-right"],
];

function makeKey(
  label: string,
  name: string,
  send: (m: ClientWsMessage) => void,
  extraClass?: string,
): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (extraClass) b.className = extraClass;
  b.addEventListener("click", () => send({ kind: "key", name }));
  return b;
}

export function renderFunctionKeys(
  parent: HTMLElement,
  send: (m: ClientWsMessage) => void,
): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "special-keys";
  for (const [label, name] of FUNC_KEYS) {
    bar.appendChild(makeKey(label, name, send));
  }
  parent.appendChild(bar);
  return bar;
}

export function renderArrowKeys(
  parent: HTMLElement,
  send: (m: ClientWsMessage) => void,
): HTMLElement {
  const grid = document.createElement("div");
  grid.className = "arrow-keys";
  for (const [label, name, cls] of ARROW_KEYS) {
    grid.appendChild(makeKey(label, name, send, `arrow-keys__btn ${cls}`));
  }
  parent.appendChild(grid);
  return grid;
}
