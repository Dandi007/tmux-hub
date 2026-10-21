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
  test("detach requests authority without changing displayed native grid", () => {
    const current: ViewportState = { owner: "native", cols: 120, rows: 40 };
    const result = handleSessionActivity(current, 0);
    expect(result.next).toEqual(current);
    expect(result.action).toEqual({ type: "reclaim" });
  });

  test("native→native: attached remains >0 no action", () => {
    const current: ViewportState = { owner: "native", cols: 120, rows: 40 };
    const result = handleSessionActivity(current, 1);
    expect(result.next).toEqual(current);
    expect(result.action).toEqual({ type: "none" });
  });

  test("web→web: attached changes but already web owner", () => {
    const current: ViewportState = { owner: "web", cols: 100, rows: 30 };
    const result = handleSessionActivity(current, 0);
    expect(result.next).toEqual(current);
    expect(result.action).toEqual({ type: "none" });
  });

  test("web→web: attached becomes >0 but already web owner", () => {
    const current: ViewportState = { owner: "web", cols: 100, rows: 30 };
    const result = handleSessionActivity(current, 1);
    expect(result.next).toEqual(current);
    expect(result.action).toEqual({ type: "none" });
  });
});

describe("handleViewportMessage: another web page on the session", () => {
  const web: ViewportState = { owner: "web", cols: 200, rows: 50 };
  test("peer pin: adopt the pane's new size, keep owning", () => {
    const r = handleViewportMessage({ kind: "viewport", cols: 56, rows: 40, owner: "web", peer: true }, web);
    expect(r.action).toEqual({ type: "resize", cols: 56, rows: 40 });
    expect(shouldSendResize(r.next)).toBe(true);
  });
  test("pinner left: reclaim", () => {
    const r = handleViewportMessage({ kind: "viewport", cols: 56, rows: 40, owner: "web", released: true }, web);
    expect(r.action).toEqual({ type: "reclaim" });
  });
  test("plain web message (own attach): no action", () => {
    expect(handleViewportMessage({ kind: "viewport", cols: 200, rows: 50, owner: "web" }, web).action).toEqual({ type: "none" });
  });
  test("own applied resize restores the pane size after an intervening peer notification", () => {
    const displaced: ViewportState = { owner: "web", cols: 164, rows: 43 };
    const r = handleViewportMessage({ kind: "viewport", cols: 183, rows: 43, owner: "web", applied: true }, displaced);
    expect(r.action).toEqual({ type: "resize", cols: 183, rows: 43 });
    expect(shouldSendResize(r.next)).toBe(true);
  });
});

 test("old web pinner release cannot take ownership from native", () => {
   const native: ViewportState = { owner: "native", cols: 80, rows: 23 };
   expect(handleViewportMessage({ kind: "viewport", cols: 197, rows: 47, owner: "web", released: true }, native))
     .toEqual({ next: native, action: { type: "none" } });
 });

 test("ordinary web zero activity waits for native metadata before any reclaim", () => {
   const web: ViewportState = { owner: "web", cols: 197, rows: 47 };
   expect(handleSessionActivity(web, 0)).toEqual({ next: web, action: { type: "none" } });
 });

 test("a still-native display rechecks a repeated zero without stealing a web peer", () => {
   const native: ViewportState = { owner: "native", cols: 80, rows: 23 };
   expect(handleSessionActivity(native, 0).action).toEqual({ type: "reclaim" });
   expect(handleSessionActivity({ ...native, owner: "web" }, 0).action).toEqual({ type: "none" });
 });

 test("first ordinary zero activity does not reclaim a confirmed web peer", () => {
   const web: ViewportState = { owner: "web", cols: 56, rows: 40 };
   expect(handleSessionActivity(web, 0).action).toEqual({ type: "none" });
 });
