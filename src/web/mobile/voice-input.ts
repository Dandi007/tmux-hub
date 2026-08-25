// src/web/mobile/voice-input.ts
// 按一下 🎤 开始录音、再按一下结束 → POST /api/voice（转写+整理）→ 文本回调落输入框（不自动发送）。
import { hubFetch } from "../hub-fetch";
import { readSse } from "./sse";

export type VoiceStatus = "idle" | "recording" | "transcribing" | "cleaning" | "error";

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
  btn.setAttribute("aria-label", "点击开始录音，再点一次结束");
  btn.textContent = "🎤";
  deps.parent.appendChild(btn);

  let mediaRec: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let recStart = 0;
  let status: VoiceStatus = "idle";
  // 这一轮还想录吗。getUserMedia 是异步的（首次还要等授权弹窗），取消完全可能发生在它返回之前，
  // 那时 mediaRec 还是 null、stop 会落空。这个标志让开流回来后能发现「人已经不想录了」。
  let wantRecording = false;
  // getUserMedia 在途。status 此时还是 idle，不足以挡住重复按下 —— 少了它，连点两次
  // 会开出两条麦克风流。
  let starting = false;
  // 端到端各阶段时间戳（performance.now()）：按下→变红→结束→打包→发出→收到。
  let tDown = 0, tRed = 0, tRelease = 0;

  const setStatus = (s: VoiceStatus, detail = "") => { status = s; btn.classList.toggle("rec", s === "recording"); deps.onStatus(s, detail); };

  const onRecorded = async (): Promise<void> => {
    const tBlob = performance.now();          // onstop 触发、blob 组装完成
    const blob = new Blob(chunks, { type: chunks[0]?.type || "audio/mp4" });
    // 太短的录音后端会直接 400，这里提前拦掉。给提示而不是静默回 idle ——
    // 「按了、没反应、也没说为什么」和真的坏掉在体感上没有区别。
    if (blob.size < 1000 || Date.now() - recStart < 300) { setStatus("idle", "🎤 太短了，多说一会儿再结束"); return; }
    setStatus("transcribing");
    const tSend = performance.now();
    try {
      // 必须走 hubFetch：/api/voice 是 authed POST，缺 X-Hub-Secret 会 401（裸 fetch 是之前转写失败的根因）。
      // /api/voice 现返回 SSE：实时推 uploaded→transcribing→cleaning→done，前端据此更新状态。
      const res = await hubFetch("/api/voice", { method: "POST", headers: { "Content-Type": blob.type, Accept: "text/event-stream" }, body: blob });
      if (!res.ok || !res.body) throw new Error(res.status === 501 ? "语音未启用" : "转写失败");
      let done: { text?: string; t?: { transcribeMs: number; cleanMs: number; totalMs: number } } | null = null;
      let errMsg = "";
      await readSse(res.body, (ev, data) => {
        if (ev === "transcribing") setStatus("transcribing");
        else if (ev === "cleaning") setStatus("cleaning");
        else if (ev === "done") done = data as typeof done;
        else if (ev === "error") errMsg = (data as { message?: string })?.message ?? "转写失败";
      });
      if (errMsg) throw new Error(errMsg);
      if (!done) throw new Error("转写中断");
      const tRecv = performance.now();
      const text = (done as { text?: string }).text, srv = (done as { t?: { transcribeMs: number; cleanMs: number; totalMs: number } }).t;
      // 各阶段报告（ms）：判断时间花在哪里。
      const roundtripMs = Math.round(tRecv - tSend);
      const rpt = {
        blobKB: Math.round(blob.size / 1024),
        permitMs: Math.round(tRed - tDown),          // 按下→变红（授权+开录）
        speakMs: Math.round(tRelease - tRed),        // 录音时长
        finalizeMs: Math.round(tSend - tRelease),    // 结束→发出（onstop 收尾+打包）
        netMs: srv ? Math.max(0, roundtripMs - srv.totalMs) : roundtripMs, // 网络往返
        transcribeMs: srv?.transcribeMs,             // 后端 blob+ASR
        cleanMs: srv?.cleanMs,                       // 后端 haiku 整理
        roundtripMs,                                 // 发出→收到
        afterReleaseMs: Math.round(tRecv - tRelease),// 结束后总等待（感知延迟）
        totalMs: Math.round(tRecv - tDown),          // 全程
      };
      console.log("[voice-timing]", JSON.stringify(rpt));
      if (text && text.trim()) {
        deps.onText(text.trim());
        const s = (n?: number) => ((n ?? 0) / 1000).toFixed(1);
        setStatus("idle", `⏱ 结束后${s(rpt.afterReleaseMs)}s · 网络${s(rpt.netMs)} 转写${s(rpt.transcribeMs)} 整理${s(rpt.cleanMs)}（录音${s(rpt.speakMs)}）`);
      } else setStatus("error", "🤔 没听清，再说一次");
    } catch (e) { setStatus("error", `⚠️ ${(e as Error).message}`); }
  };

  const startRec = async (): Promise<void> => {
    // 只在真正占用麦克风期间拦截重按；error/idle 都允许重试（否则一次失败就永久卡死）。
    if (starting || status === "recording" || status === "transcribing") return;
    starting = true;
    wantRecording = true;
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // 开流期间用户已经取消了（授权弹窗还没回来就又点了一下）。
      // 这里必须原地放弃：若照常 start()，录音会在取消之后才开始，而那次 stop 早已落空，
      // 于是麦克风一直开着、状态卡在 recording，用户再按又被入口的重入判定挡掉 ——
      // 表现就是「点了没反应，要连点好几次才录上」。
      if (!wantRecording) {
        stream.getTracks().forEach((t) => t.stop());
        setStatus("idle", "🎤 已取消");
        return;
      }
      const mime = pickMime();
      mediaRec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunks = [];
      mediaRec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      mediaRec.onstop = () => { stream?.getTracks().forEach((t) => t.stop()); void onRecorded(); };
      mediaRec.start();
      recStart = Date.now();
      tRed = performance.now();   // 麦克风变红、开始录音
      setStatus("recording");
    } catch (e) {
      // 关键修复：若已拿到麦克风流但后续（MediaRecorder 构造等）失败，必须停掉流，
      // 否则麦克风被泄漏的流占住 → 之后每次 getUserMedia 都 NotReadableError「不可用」。
      stream?.getTracks().forEach((t) => t.stop());
      const err = e as Error;
      console.error("[voice] mic failed:", err.name, err.message);
      const reason = typeof navigator === "undefined" || !navigator.mediaDevices ? "需 HTTPS 环境"
        : err.name === "NotAllowedError" ? "权限被拒，请在浏览器/系统设置里允许麦克风"
        : err.name === "NotFoundError" ? "未找到麦克风设备"
        : err.name === "NotReadableError" ? "麦克风被占用，请关掉其它占用它的 App/标签页后重试"
        : err.name === "SecurityError" ? "安全限制（需 HTTPS）"
        : (err.message || err.name || "未知错误");
      setStatus("error", `🎤 麦克风不可用：${reason}`);
    } finally {
      starting = false;
    }
  };
  const stopRec = (): void => {
    tRelease = performance.now(); // 结束录音
    // 先落这个标志：stop 落空（录音还没起来）时，靠它让 startRec 回来后自己收摊。
    wantRecording = false;
    if (mediaRec && mediaRec.state !== "inactive") mediaRec.stop();
  };

  // 按一下开始、再按一下结束（移动端与桌面同一套手势）。
  // 曾经是「按住说话」：鼠标上按住十几秒说完一段话不可用，移动端还要额外压制长按放大镜 ——
  // 两端都在为「省一次点击」付代价。
  const toggle = (): void => {
    if (status === "recording") { stopRec(); return; }
    // 授权/开流在途时再按一次 = 取消本次；startRec 拿到流后会发现 wantRecording 已落、自行收摊。
    if (starting) { wantRecording = false; return; }
    tDown = performance.now();
    void startRec();
  };

  // 用 pointerdown 而不是 click：preventDefault 要挡住焦点转移 —— 移动端上按钮一旦抢焦点，
  // 软键盘会收起、输入栏退出编辑态。
  btn.addEventListener("pointerdown", (e) => { e.preventDefault(); toggle(); });
  // 长按在部分移动浏览器走 contextmenu 路径（原生文字选择/放大镜），这里一并抑制。
  btn.addEventListener("contextmenu", (e) => e.preventDefault());
  return btn;
}
