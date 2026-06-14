import type { ClientWsMessage } from "@shared/protocol";

export type Phase = "draft" | "loading" | "review";
export type SuggestResult =
  | { translated: true; command: string }
  | { translated: false }
  | { error: string };

export type SuggestFlowEffects = {
  getText: () => string;
  setText: (s: string) => void;
  send: (msg: ClientWsMessage) => void;
  getSession: () => string | null;
  getMode: () => "shell" | "other";
  requestSuggestion: (session: string, text: string, signal: AbortSignal) => Promise<SuggestResult>;
  onPhaseChange: (phase: Phase) => void;
  toast: (msg: string, kind?: "info" | "error") => void;
};

export type SuggestFlow = {
  primary: () => Promise<void>;
  undo: () => void;
  phase: () => Phase;
};

function literalSend(send: SuggestFlowEffects["send"], text: string): void {
  if (text) send({ kind: "keys", literal: text });
  send({ kind: "key", name: "Enter" });
}

export function createSuggestFlow(fx: SuggestFlowEffects): SuggestFlow {
  let phase: Phase = "draft";
  let original = "";
  let abort: AbortController | null = null;

  const setPhase = (p: Phase) => { phase = p; fx.onPhaseChange(p); };

  const primary = async (): Promise<void> => {
    if (phase === "loading") { abort?.abort(); abort = null; setPhase("draft"); return; }
    if (phase === "review") { literalSend(fx.send, fx.getText()); original = ""; fx.setText(""); setPhase("draft"); return; }

    // phase === draft
    const text = fx.getText().trim();
    if (text === "") { fx.send({ kind: "key", name: "Enter" }); fx.setText(""); return; }

    const session = fx.getSession();
    if (fx.getMode() !== "shell" || !session) { literalSend(fx.send, fx.getText()); fx.setText(""); return; }

    original = fx.getText();
    abort = new AbortController();
    setPhase("loading");
    let result: SuggestResult;
    try {
      result = await fx.requestSuggestion(session, text, abort.signal);
    } catch (e) {
      if ((e as Error).name === "AbortError") return; // 取消：phase 已置 draft
      result = { error: (e as Error).message };
    }
    if (phase !== "loading") return;                       // 已被取消
    if (fx.getSession() !== session) { setPhase("draft"); return; } // 串台：丢弃

    if ("translated" in result && result.translated) {
      fx.setText((result as { translated: true; command: string }).command);
      setPhase("review");
    } else if ("error" in result) {
      fx.toast("推荐失败，可直接编辑发送", "error");
      fx.setText(original);
      setPhase("draft");
    } else {
      literalSend(fx.send, original);                      // translated:false → 字面发送
      fx.setText("");
      setPhase("draft");
    }
  };

  const undo = (): void => {
    if (phase !== "review") return;
    fx.setText(original);
    setPhase("draft");
  };

  return { primary, undo, phase: () => phase };
}
