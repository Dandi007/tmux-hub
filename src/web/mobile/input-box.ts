import type { ClientWsMessage } from "@shared/protocol";

export function renderInputBox(
  parent: HTMLElement,
  send: (m: ClientWsMessage) => void,
): HTMLFormElement {
  const wrap = document.createElement("form");
  wrap.className = "mobile-input";

  const ta = document.createElement("textarea");
  ta.className = "mobile-input__textarea";
  ta.rows = 4;
  ta.placeholder = "输入并提交…";

  const btnRow = document.createElement("div");
  btnRow.className = "mobile-input__buttons";

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "提交 ↵";

  btnRow.appendChild(submit);
  wrap.append(ta, btnRow);
  parent.appendChild(wrap);

  wrap.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = ta.value;
    // Empty submit means "send a bare Enter" — equivalent to tapping Enter on
    // the special-keys bar but with zero extra steps. Non-empty: send the text
    // through tmux send-keys -l first, then a real Enter key event (so raw-mode
    // TUIs receive the byte sequence their application mode expects, not a
    // literal 0x0D appended to the text).
    if (text) send({ kind: "keys", literal: text });
    send({ kind: "key", name: "Enter" });
    ta.value = "";
  });

  return wrap;
}
