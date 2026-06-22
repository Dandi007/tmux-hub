// src/web/mobile/voice-input.ts
// 按住 🎤 录音 → POST /api/voice（转写+整理）→ 文本回调落输入框（不自动发送）。
import { hubFetch } from "../hub-fetch";

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
  // 端到端各阶段时间戳（performance.now()）：按下→变红→松手→打包→发出→收到。
  let tDown = 0, tRed = 0, tRelease = 0;

  const setStatus = (s: VoiceStatus, detail = "") => { status = s; btn.classList.toggle("rec", s === "recording"); deps.onStatus(s, detail); };

  const onRecorded = async (): Promise<void> => {
    const tBlob = performance.now();          // onstop 触发、blob 组装完成
    const blob = new Blob(chunks, { type: chunks[0]?.type || "audio/mp4" });
    if (blob.size < 1000 || Date.now() - recStart < 300) { setStatus("idle"); return; }
    setStatus("transcribing");
    const tSend = performance.now();
    try {
      // 必须走 hubFetch：/api/voice 是 authed POST，缺 X-Hub-Secret 会 401（裸 fetch 是之前转写失败的根因）。
      const res = await hubFetch("/api/voice", { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
      const tRecv = performance.now();
      if (!res.ok) throw new Error(res.status === 501 ? "语音未启用" : "转写失败");
      const data = (await res.json()) as { text?: string; t?: { transcribeMs: number; cleanMs: number; totalMs: number } };
      const text = data.text, srv = data.t;
      // 各阶段报告（ms）：判断时间花在哪里。
      const roundtripMs = Math.round(tRecv - tSend);
      const rpt = {
        blobKB: Math.round(blob.size / 1024),
        permitMs: Math.round(tRed - tDown),          // 按下→变红（授权+开录）
        speakMs: Math.round(tRelease - tRed),        // 录音时长
        finalizeMs: Math.round(tSend - tRelease),    // 松手→发出（onstop 收尾+打包）
        netMs: srv ? Math.max(0, roundtripMs - srv.totalMs) : roundtripMs, // 网络往返
        transcribeMs: srv?.transcribeMs,             // 后端 blob+ASR
        cleanMs: srv?.cleanMs,                       // 后端 haiku 整理
        roundtripMs,                                 // 发出→收到
        afterReleaseMs: Math.round(tRecv - tRelease),// 松手后总等待（感知延迟）
        totalMs: Math.round(tRecv - tDown),          // 全程
      };
      console.log("[voice-timing]", JSON.stringify(rpt));
      if (text && text.trim()) {
        deps.onText(text.trim());
        const s = (n?: number) => ((n ?? 0) / 1000).toFixed(1);
        setStatus("idle", `⏱ 松手后${s(rpt.afterReleaseMs)}s · 网络${s(rpt.netMs)} 转写${s(rpt.transcribeMs)} 整理${s(rpt.cleanMs)}（录音${s(rpt.speakMs)}）`);
      } else setStatus("error", "🤔 没听清，再说一次");
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
      tRed = performance.now();   // 麦克风变红、开始录音
      setStatus("recording");
    } catch { setStatus("error", "🎤 麦克风不可用"); }
  };
  const stopRec = (): void => {
    tRelease = performance.now(); // 松手
    if (mediaRec && mediaRec.state !== "inactive") mediaRec.stop();
  };

  btn.addEventListener("pointerdown", (e) => { e.preventDefault(); tDown = performance.now(); btn.setPointerCapture?.(e.pointerId); void startRec(); });
  btn.addEventListener("pointerup", (e) => { e.preventDefault(); stopRec(); });
  btn.addEventListener("pointercancel", () => stopRec());
  return btn;
}
