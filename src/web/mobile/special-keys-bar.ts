import type { ClientWsMessage } from "@shared/protocol";

const FUNC_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["Esc", "Escape"],
  ["Tab", "Tab"],
  ["^C", "C-c"],
  ["^D", "C-d"],
  ["^Z", "C-z"],
  ["↑", "Up"],
];

const ARROW_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["←", "Left"],
  ["↓", "Down"],
  ["→", "Right"],
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
  const row = document.createElement("div");
  row.className = "arrow-keys";
  for (const [label, name] of ARROW_KEYS) {
    row.appendChild(makeKey(label, name, send, "arrow-keys__btn"));
  }
  parent.appendChild(row);
  return row;
}
