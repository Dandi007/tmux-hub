import type { ClientWsMessage } from "@shared/protocol";

const KEYS: ReadonlyArray<readonly [string, string]> = [
  ["Esc", "Escape"],
  ["Tab", "Tab"],
  ["↑", "Up"],
  ["↓", "Down"],
  ["←", "Left"],
  ["→", "Right"],
  ["^C", "C-c"],
];

export function renderSpecialKeysBar(
  parent: HTMLElement,
  send: (m: ClientWsMessage) => void,
): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "special-keys";
  for (const [label, name] of KEYS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", () => send({ kind: "key", name }));
    bar.appendChild(b);
  }
  parent.appendChild(bar);
  return bar;
}
