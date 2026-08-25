// 🎤 按钮是「按一下开始、再按一下结束」。竞态出在 getUserMedia 异步上：
// 取消可能发生在开流返回之前，那次 stop 落空，录音却在取消后才启动，
// 于是麦克风一直开着、状态卡死 —— 症状是点了没反应，要连点好几次才录上。
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
const last = () => statuses[statuses.length - 1]!;

describe("语音按钮 · 点按开始/结束", () => {
  test("开流尚未返回时再点一次 → 取消本次，不留下在录的麦克风", async () => {
    btn.fire("pointerdown");
    btn.fire("pointerdown");        // 取消早于 getUserMedia resolve
    deferredResolve!(fakeStream()); // 授权这时才回来
    await settle();

    // 修复前：这里会 start() 一个永远不会被 stop 的录音。
    expect(recorders.length).toBe(0);
    expect(stoppedTracks).toBe(1);  // 拿到的流当场释放，不泄漏麦克风
    expect(last().s).toBe("idle");
    expect(last().detail).toContain("已取消");
  });

  test("上一条的关键后果：紧接着再点一下仍能录（不会卡死）", async () => {
    btn.fire("pointerdown");
    btn.fire("pointerdown");
    deferredResolve!(fakeStream());
    await settle();

    btn.fire("pointerdown");
    deferredResolve!(fakeStream());
    await settle();

    expect(recorders.length).toBe(1);
    expect(recorders[0]!.startCalls).toBe(1);
    expect(last().s).toBe("recording");
  });

  test("点一下开始、再点一下结束 → 录音起来了，也确实停了", async () => {
    btn.fire("pointerdown");
    deferredResolve!(fakeStream());
    await settle();
    expect(last().s).toBe("recording");

    btn.fire("pointerdown");
    expect(recorders[0]!.stopCalls).toBe(1);
    expect(stoppedTracks).toBe(1); // onstop 里释放麦克风
  });

  test("开流在途时连按两次 → 只申请一次麦克风", async () => {
    btn.fire("pointerdown");
    btn.fire("pointerdown");
    expect(openedStreams).toBe(1);
  });

  test("录音中再次按下 → 结束本次，而不是再开一条流", async () => {
    btn.fire("pointerdown");
    deferredResolve!(fakeStream());
    await settle();
    btn.fire("pointerdown");
    expect(openedStreams).toBe(1);
    expect(recorders.length).toBe(1);
    expect(recorders[0]!.stopCalls).toBe(1);
  });

  test("录得太短 → 明确提示，而不是静默什么都不发生", async () => {
    btn.fire("pointerdown");
    deferredResolve!(fakeStream());
    await settle();
    btn.fire("pointerdown"); // 没有任何 ondataavailable，blob 为空
    await settle();
    expect(last().s).toBe("idle");
    expect(last().detail).toContain("太短");
  });
});
