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
    if (!text) return;
    // Send the text literally, then trigger Enter as a real key event rather
    // than appending a raw \r byte. tmux send-keys -l "...\r" injects 0x0D
    // as a literal character; in cooked-mode shells the tty driver maps it
    // to NL and submits the line, but in raw-mode TUIs (claude-code, vim,
    // less, Ink-based CLIs) ICRNL is off and the app reads 0x0D directly —
    // most don't treat it as "submit", they just move the cursor home. That
    // produced the "text appears, Enter doesn't fire" symptom. Going
    // through tmux's Enter keyword lets tmux emit the byte sequence the
    // pane's current application mode expects.
    send({ kind: "keys", literal: text });
    send({ kind: "key", name: "Enter" });
    ta.value = "";
  });

  return wrap;
}
