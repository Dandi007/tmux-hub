// src/web/mobile/voice-input.ts
// 按住 🎤 录音 → POST /api/voice（转写+整理）→ 文本回调落输入框（不自动发送）。
export type VoiceStatus = "idle" | "recording" | "transcribing" | "error";

export function pickMime(): string {
  for (const m of ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"]) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return "";
}

export type VoiceDeps = {
  parent: HTMLElement;
  onText: (text: string) => void;
  onStatus: (s: VoiceStatus, detail?: string) => void;
};

export function renderVoiceButton(deps: VoiceDeps): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "input-bar__mic";
  btn.setAttribute("aria-label", "按住说话");
  btn.textContent = "🎤";
  deps.parent.appendChild(btn);

  let mediaRec: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let recStart = 0;
  let status: VoiceStatus = "idle";

  const setStatus = (s: VoiceStatus, detail = "") => { status = s; btn.classList.toggle("rec", s === "recording"); deps.onStatus(s, detail); };

  const onRecorded = async (): Promise<void> => {
    const blob = new Blob(chunks, { type: chunks[0]?.type || "audio/mp4" });
    if (blob.size < 1000 || Date.now() - recStart < 300) { setStatus("idle"); return; }
    setStatus("transcribing");
    try {
      const res = await fetch("/api/voice", { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
      if (!res.ok) throw new Error(res.status === 501 ? "语音未启用" : "转写失败");
      const { text } = (await res.json()) as { text?: string };
      if (text && text.trim()) { deps.onText(text.trim()); setStatus("idle"); }
      else setStatus("error", "🤔 没听清，再说一次");
    } catch (e) { setStatus("error", `⚠️ ${(e as Error).message}`); }
  };

  const startRec = async (): Promise<void> => {
    if (status !== "idle") return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickMime();
      mediaRec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunks = [];
      mediaRec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      mediaRec.onstop = () => { stream.getTracks().forEach((t) => t.stop()); void onRecorded(); };
      mediaRec.start();
      recStart = Date.now();
      setStatus("recording");
    } catch { setStatus("error", "🎤 麦克风不可用"); }
  };
  const stopRec = (): void => { if (mediaRec && mediaRec.state !== "inactive") mediaRec.stop(); };

  btn.addEventListener("pointerdown", (e) => { e.preventDefault(); btn.setPointerCapture?.(e.pointerId); void startRec(); });
  btn.addEventListener("pointerup", (e) => { e.preventDefault(); stopRec(); });
  btn.addEventListener("pointercancel", () => stopRec());
  return btn;
}
