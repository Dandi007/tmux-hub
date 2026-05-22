import { describe, test, expect } from "bun:test";
import { keyEventToTmuxToken } from "../../src/shared/key-map";

describe("keyEventToTmuxToken", () => {
  test("Enter / Escape / Tab / Backspace", () => {
    expect(keyEventToTmuxToken({ key: "Enter" })).toBe("Enter");
    expect(keyEventToTmuxToken({ key: "Escape" })).toBe("Escape");
    expect(keyEventToTmuxToken({ key: "Tab" })).toBe("Tab");
    expect(keyEventToTmuxToken({ key: "Backspace" })).toBe("BSpace");
  });
  test("Arrow keys", () => {
    expect(keyEventToTmuxToken({ key: "ArrowUp" })).toBe("Up");
    expect(keyEventToTmuxToken({ key: "ArrowDown" })).toBe("Down");
    expect(keyEventToTmuxToken({ key: "ArrowLeft" })).toBe("Left");
    expect(keyEventToTmuxToken({ key: "ArrowRight" })).toBe("Right");
  });
  test("Home / End / Page / Delete", () => {
    expect(keyEventToTmuxToken({ key: "Home" })).toBe("Home");
    expect(keyEventToTmuxToken({ key: "End" })).toBe("End");
    expect(keyEventToTmuxToken({ key: "PageUp" })).toBe("PageUp");
    expect(keyEventToTmuxToken({ key: "PageDown" })).toBe("PageDown");
    expect(keyEventToTmuxToken({ key: "Delete" })).toBe("Delete");
  });
  test("Ctrl-letter", () => {
    expect(keyEventToTmuxToken({ key: "c", ctrlKey: true })).toBe("C-c");
    expect(keyEventToTmuxToken({ key: "D", ctrlKey: true })).toBe("C-d");
    expect(keyEventToTmuxToken({ key: "z", ctrlKey: true })).toBe("C-z");
    expect(keyEventToTmuxToken({ key: "l", ctrlKey: true })).toBe("C-l");
  });
  test("plain printable returns null", () => {
    expect(keyEventToTmuxToken({ key: "a" })).toBeNull();
    expect(keyEventToTmuxToken({ key: "1" })).toBeNull();
    expect(keyEventToTmuxToken({ key: " " })).toBeNull();
  });
  test("Ctrl with non-letter returns null (let raw bytes go through)", () => {
    expect(keyEventToTmuxToken({ key: "1", ctrlKey: true })).toBeNull();
  });
});
