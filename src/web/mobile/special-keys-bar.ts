import type { ClientWsMessage } from "@shared/protocol";

const FUNC_KEYS_BEFORE: ReadonlyArray<readonly [string, string]> = [
  ["Esc", "Escape"],
  ["Tab", "Tab"],
];

const FUNC_KEYS_AFTER: ReadonlyArray<readonly [string, string]> = [
  ["^C", "C-c"],
  ["^D", "C-d"],
];

function makeKey(
  label: string,
  name: string,
  send: (m: ClientWsMessage) => void,
): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", () => send({ kind: "key", name }));
  return b;
}

export function renderToolbarKeys(
  parent: HTMLElement,
  send: (m: ClientWsMessage) => void,
): HTMLElement {
  const grid = document.createElement("div");
  grid.className = "special-keys toolbar-keys";

  for (const [label, name] of FUNC_KEYS_BEFORE) {
    grid.appendChild(makeKey(label, name, send));
  }

  const up = makeKey("↑", "Up", send);
  up.className = "tk-up";
  grid.appendChild(up);

  for (const [label, name] of FUNC_KEYS_AFTER) {
    grid.appendChild(makeKey(label, name, send));
  }

  const left = makeKey("←", "Left", send);
  left.className = "tk-left";
  grid.appendChild(left);

  const down = makeKey("↓", "Down", send);
  down.className = "tk-down";
  grid.appendChild(down);

  const right = makeKey("→", "Right", send);
  right.className = "tk-right";
  grid.appendChild(right);

  const ctrlz = makeKey("^Z", "C-z", send);
  ctrlz.className = "tk-ctrlz";
  grid.appendChild(ctrlz);

  const enter = makeKey("↵", "Enter", send);
  enter.className = "tk-enter";
  grid.appendChild(enter);

  parent.appendChild(grid);
  return grid;
}
