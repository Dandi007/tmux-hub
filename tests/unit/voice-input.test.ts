import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { pickMime, renderVoiceButton } from "../../src/web/mobile/voice-input";

describe("pickMime", () => {
  test("无 MediaRecorder（测试环境）→ 返回空串，不抛", () => {
    expect(typeof pickMime()).toBe("string");
  });
});

describe("语音按钮 · 长按不选中文字（H6）", () => {
  test(".input-bar__mic 规则块含 user-select / touch-callout / touch-action 抑制属性", () => {
    const css = readFileSync(new URL("../../src/web/style.css", import.meta.url), "utf8");
    const m = css.match(/\.input-bar__attach,\s*\.input-bar__mic\s*\{[^}]*\}/);
    expect(m).not.toBeNull();
    const block = (m as RegExpMatchArray)[0];
    expect(block).toContain("user-select: none");
    expect(block).toContain("-webkit-user-select: none");
    expect(block).toContain("-webkit-touch-callout: none");
    expect(block).toContain("touch-action: none");
  });

  test("contextmenu 被注册且 preventDefault（长按不弹系统菜单）", () => {
    const handlers: Record<string, Array<(e: unknown) => void>> = {};
    const btn = {
      type: "", className: "", textContent: "",
      classList: { toggle() {} },
      setAttribute() {},
      setPointerCapture() {},
      addEventListener(k: string, h: (e: unknown) => void) { (handlers[k] ??= []).push(h); },
    };
    (globalThis as Record<string, unknown>).document = { createElement: () => btn };
    try {
      renderVoiceButton({
        parent: { appendChild() {} } as unknown as HTMLElement,
        onText: () => {},
        onStatus: () => {},
      });
      expect(handlers["contextmenu"]?.length).toBe(1);
      let prevented = false;
      for (const h of handlers["contextmenu"] ?? []) h({ preventDefault() { prevented = true; } });
      expect(prevented).toBe(true);
    } finally {
      delete (globalThis as Record<string, unknown>).document;
    }
  });
});
