// 🎤 按钮的按下/松手竞态。真实症状：点一下经常没反应，要连点好几次才录上。
// 根因是 getUserMedia 异步 —— 松手可能发生在开流返回之前，那次 stop 落空，
// 录音却在松手后才启动，于是麦克风一直开着、状态卡死。
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { renderVoiceButton, type VoiceStatus } from "../../src/web/mobile/voice-input";

type Handler = (e: unknown) => void;

function fakeButton() {
  const handlers: Record<string, Handler[]> = {};
  return {
    type: "", className: "", textContent: "",
    classList: { toggle() {} },
    setAttribute() {},
    setPointerCapture() {},
    addEventListener(k: string, h: Handler) { (handlers[k] ??= []).push(h); },
    fire(k: string) { for (const h of handlers[k] ?? []) h({ pointerId: 1, preventDefault() {} }); },
  };
}

let stoppedTracks = 0;
let recorders: FakeRecorder[] = [];
let openedStreams = 0;
let deferredResolve: ((s: unknown) => void) | null = null;

class FakeRecorder {
  static isTypeSupported() { return true; }
  state = "inactive";
  ondataavailable: ((e: unknown) => void) | null = null;
  onstop: (() => void) | null = null;
  startCalls = 0;
  stopCalls = 0;
  constructor(_stream: unknown, _opts?: unknown) { recorders.push(this); }
  start() { this.startCalls++; this.state = "recording"; }
  stop() { this.stopCalls++; this.state = "inactive"; this.onstop?.(); }
}

const fakeStream = () => ({ getTracks: () => [{ stop() { stoppedTracks++; } }] });

let btn: ReturnType<typeof fakeButton>;
let statuses: Array<{ s: VoiceStatus; detail?: string }>;

beforeEach(() => {
  stoppedTracks = 0; recorders = []; openedStreams = 0; deferredResolve = null;
  btn = fakeButton();
  statuses = [];
  (globalThis as Record<string, unknown>).document = { createElement: () => btn };
  (globalThis as Record<string, unknown>).MediaRecorder = FakeRecorder;
  (globalThis as Record<string, unknown>).navigator = {
    mediaDevices: {
      // 开流故意不立即 resolve：这样才能精确制造「松手早于授权返回」。
      getUserMedia: () => new Promise((res) => { openedStreams++; deferredResolve = res; }),
    },
  };
  renderVoiceButton({
    parent: { appendChild() {} } as unknown as HTMLElement,
    onText: () => {},
    onStatus: (s, detail) => statuses.push({ s, detail }),
  });
});

afterEach(() => {
  for (const k of ["document", "MediaRecorder", "navigator"]) delete (globalThis as Record<string, unknown>)[k];
});

const settle = () => new Promise((r) => setTimeout(r, 0));
const last = () => statuses[statuses.length - 1];

describe("语音按钮 · 按下/松手竞态", () => {
  test("点一下就松手（开流尚未返回）→ 放弃本次，不留下在录的麦克风", async () => {
    btn.fire("pointerdown");
    btn.fire("pointerup");          // 松手早于 getUserMedia resolve
    deferredResolve!(fakeStream()); // 授权这时才回来
    await settle();

    // 修复前：这里会 start() 一个永远不会被 stop 的录音。
    expect(recorders.length).toBe(0);
    expect(stoppedTracks).toBe(1);  // 拿到的流当场释放，不泄漏麦克风
    expect(last().s).toBe("idle");
    expect(last().detail).toContain("按住说话");
  });

  test("上一条的关键后果：紧接着正常按住仍能录（不会卡死）", async () => {
    btn.fire("pointerdown");
    btn.fire("pointerup");
    deferredResolve!(fakeStream());
    await settle();

    btn.fire("pointerdown");
    deferredResolve!(fakeStream());
    await settle();

    expect(recorders.length).toBe(1);
    expect(recorders[0].startCalls).toBe(1);
    expect(last().s).toBe("recording");
  });

  test("正常按住再松手 → 录音起来了，也确实停了", async () => {
    btn.fire("pointerdown");
    deferredResolve!(fakeStream());
    await settle();
    expect(last().s).toBe("recording");

    btn.fire("pointerup");
    expect(recorders[0].stopCalls).toBe(1);
    expect(stoppedTracks).toBe(1); // onstop 里释放麦克风
  });

  test("开流在途时连按两次 → 只开一条流（不重复申请麦克风）", async () => {
    btn.fire("pointerdown");
    btn.fire("pointerdown");
    expect(openedStreams).toBe(1);
  });

  test("录音中再次按下不重入", async () => {
    btn.fire("pointerdown");
    deferredResolve!(fakeStream());
    await settle();
    btn.fire("pointerdown");
    expect(openedStreams).toBe(1);
    expect(recorders.length).toBe(1);
  });

  test("录得太短 → 明确提示，而不是静默什么都不发生", async () => {
    btn.fire("pointerdown");
    deferredResolve!(fakeStream());
    await settle();
    btn.fire("pointerup"); // 没有任何 ondataavailable，blob 为空
    await settle();
    expect(last().s).toBe("idle");
    expect(last().detail).toContain("太短");
  });
});
