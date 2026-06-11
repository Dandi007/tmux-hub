import { describe, test, expect } from "bun:test";
import { getNativeAttachCount } from "../../src/server/viewport-pinner";
import {
  handleViewportMessage,
  shouldSendResize,
  handleSessionActivity,
  type ViewportState,
} from "../../src/web/viewport-owner";

describe("getNativeAttachCount", () => {
  test("returns 0 when no clients attached", async () => {
    const runner = async (args: string[]) => {
      expect(args).toEqual(["display-message", "-p", "-t", "test-session", "#{session_attached}"]);
      return "0";
    };
    const count = await getNativeAttachCount("test-session", runner);
    expect(count).toBe(0);
  });

  test("returns 1 when one client attached", async () => {
    const runner = async () => "1";
    const count = await getNativeAttachCount("test-session", runner);
    expect(count).toBe(1);
  });

  test("returns 2 when two clients attached", async () => {
    const runner = async () => "2";
    const count = await getNativeAttachCount("test-session", runner);
    expect(count).toBe(2);
  });

  test("handles whitespace", async () => {
    const runner = async () => "  3  \n";
    const count = await getNativeAttachCount("test-session", runner);
    expect(count).toBe(3);
  });

  test("returns 0 on invalid output", async () => {
    const runner = async () => "invalid";
    const count = await getNativeAttachCount("test-session", runner);
    expect(count).toBe(0);
  });

  test("throws error when runner fails", async () => {
    const runner = async () => {
      throw new Error("tmux command failed");
    };
    await expect(getNativeAttachCount("test-session", runner)).rejects.toThrow("tmux command failed");
  });
});

describe("handleViewportMessage", () => {
  test("web→native: adopts server viewport", () => {
    const current: ViewportState = { owner: "web", cols: 100, rows: 30 };
    const msg = { kind: "viewport" as const, cols: 120, rows: 40, owner: "native" as const };
    const result = handleViewportMessage(msg, current);
    expect(result.next).toEqual({ owner: "native", cols: 120, rows: 40 });
    expect(result.action).toEqual({ type: "resize", cols: 120, rows: 40 });
  });

  test("native→web: no action needed", () => {
    const current: ViewportState = { owner: "native", cols: 120, rows: 40 };
    const msg = { kind: "viewport" as const, cols: 100, rows: 30, owner: "web" as const };
    const result = handleViewportMessage(msg, current);
    expect(result.next).toEqual({ owner: "web", cols: 100, rows: 30 });
    expect(result.action).toEqual({ type: "none" });
  });

  test("native→native: updates size", () => {
    const current: ViewportState = { owner: "native", cols: 120, rows: 40 };
    const msg = { kind: "viewport" as const, cols: 150, rows: 50, owner: "native" as const };
    const result = handleViewportMessage(msg, current);
    expect(result.next).toEqual({ owner: "native", cols: 150, rows: 50 });
    expect(result.action).toEqual({ type: "resize", cols: 150, rows: 50 });
  });

  test("web→web: no action", () => {
    const current: ViewportState = { owner: "web", cols: 100, rows: 30 };
    const msg = { kind: "viewport" as const, cols: 110, rows: 35, owner: "web" as const };
    const result = handleViewportMessage(msg, current);
    expect(result.next).toEqual({ owner: "web", cols: 110, rows: 35 });
    expect(result.action).toEqual({ type: "none" });
  });
});

describe("shouldSendResize", () => {
  test("web owner: allows resize", () => {
    const state: ViewportState = { owner: "web", cols: 100, rows: 30 };
    expect(shouldSendResize(state)).toBe(true);
  });

  test("native owner: suppresses resize", () => {
    const state: ViewportState = { owner: "native", cols: 120, rows: 40 };
    expect(shouldSendResize(state)).toBe(false);
  });
});

describe("handleSessionActivity", () => {
  test("native→web: attached drops to 0 triggers reclaim", () => {
    const current: ViewportState = { owner: "native", cols: 120, rows: 40 };
    const result = handleSessionActivity(current, 0, 100, 30);
    expect(result.next).toEqual({ owner: "web", cols: 100, rows: 30 });
    expect(result.action).toEqual({ type: "resize", cols: 100, rows: 30 });
  });

  test("native→native: attached remains >0 no action", () => {
    const current: ViewportState = { owner: "native", cols: 120, rows: 40 };
    const result = handleSessionActivity(current, 1, 100, 30);
    expect(result.next).toEqual(current);
    expect(result.action).toEqual({ type: "none" });
  });

  test("web→web: attached changes but already web owner", () => {
    const current: ViewportState = { owner: "web", cols: 100, rows: 30 };
    const result = handleSessionActivity(current, 0, 110, 35);
    expect(result.next).toEqual(current);
    expect(result.action).toEqual({ type: "none" });
  });

  test("web→web: attached becomes >0 but already web owner", () => {
    const current: ViewportState = { owner: "web", cols: 100, rows: 30 };
    const result = handleSessionActivity(current, 1, 110, 35);
    expect(result.next).toEqual(current);
    expect(result.action).toEqual({ type: "none" });
  });
});
