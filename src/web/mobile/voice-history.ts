// 「我的语音历史」overlay：拉取当前账号的语音记录（文本 + 原始音频），可回放。
// 音频经 hubFetch 取（带 X-Hub-Secret；经 gate 时 cookie 注入身份）→ blob → objectURL 播放。
import { hubFetch } from "../hub-fetch";

interface VoiceItem {
  id: number;
  text: string;
  audio_blob_id: string | null;
  mime: string | null;
  bytes: number | null;
  created_at: string;
}

function fmtTime(iso: string): string {
  // sqlite datetime('now') 是 UTC "YYYY-MM-DD HH:MM:SS"；补 Z 后本地化显示。
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

let openObjectUrl: string | null = null;

export function openVoiceHistory(): void {
  // 单例：已开则不重复。
  if (document.getElementById("voice-history-overlay")) return;

  const overlay = document.createElement("div");
  overlay.id = "voice-history-overlay";
  overlay.className = "voice-history";

  const panel = document.createElement("div");
  panel.className = "voice-history__panel";
  overlay.appendChild(panel);

  const head = document.createElement("div");
  head.className = "voice-history__head";
  const title = document.createElement("span");
  title.textContent = "我的语音历史";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "voice-history__close";
  closeBtn.setAttribute("aria-label", "关闭");
  closeBtn.textContent = "✕";
  head.append(title, closeBtn);
  panel.appendChild(head);

  const list = document.createElement("div");
  list.className = "voice-history__list";
  list.textContent = "加载中…";
  panel.appendChild(list);

  const close = (): void => {
    if (openObjectUrl) { URL.revokeObjectURL(openObjectUrl); openObjectUrl = null; }
    overlay.remove();
  };
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  document.body.appendChild(overlay);

  void loadHistory(list);
}

async function loadHistory(list: HTMLElement): Promise<void> {
  let items: VoiceItem[];
  try {
    const res = await hubFetch("/api/voice/history");
    if (res.status === 501) { list.textContent = "语音功能未启用"; return; }
    if (!res.ok) { list.textContent = `加载失败（${res.status}）`; return; }
    ({ items } = (await res.json()) as { items: VoiceItem[] });
  } catch {
    list.textContent = "加载失败，请重试";
    return;
  }

  list.replaceChildren();
  if (!items.length) {
    list.textContent = "还没有语音记录";
    return;
  }

  for (const it of items) {
    const row = document.createElement("div");
    row.className = "voice-history__item";

    const meta = document.createElement("div");
    meta.className = "voice-history__meta";
    meta.textContent = fmtTime(it.created_at);

    const text = document.createElement("div");
    text.className = "voice-history__text";
    text.textContent = it.text;

    row.append(meta, text);

    if (it.audio_blob_id) {
      const play = document.createElement("button");
      play.type = "button";
      play.className = "voice-history__play";
      play.textContent = "▶ 播放";
      play.addEventListener("click", () => void playAudio(it.audio_blob_id as string, play));
      row.appendChild(play);
    }

    list.appendChild(row);
  }
}

async function playAudio(blobId: string, btn: HTMLButtonElement): Promise<void> {
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = "加载中…";
  try {
    const res = await hubFetch(`/api/voice/audio/${encodeURIComponent(blobId)}`);
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    if (openObjectUrl) URL.revokeObjectURL(openObjectUrl);
    openObjectUrl = URL.createObjectURL(blob);
    const audio = new Audio(openObjectUrl);
    audio.addEventListener("ended", () => { btn.textContent = prev; btn.disabled = false; });
    await audio.play();
    btn.textContent = "⏸ 播放中";
    btn.disabled = false;
  } catch {
    btn.textContent = "✕ 失败";
    setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 1500);
  }
}
