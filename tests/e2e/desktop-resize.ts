import { test, expect } from "./fixtures";
import { bindSecret } from "./helpers";
import type { Page } from "@playwright/test";

const tab = (page: Page, name: string) => page.locator(`.tab-bar__tab[data-session="${name}"]`);
async function openApp(page: Page): Promise<void> {
  await page.goto("/"); await bindSecret(page); await page.reload();
}

export function defineResizeAcknowledgementTest(): void {
  test("resize fits the current window after an older applied acknowledgement arrives", async ({ page, ctx }) => {
    const name = await ctx.createSession();
    const size = () => ctx.tmuxE2E(["display", "-p", "-t", name, "#{window_width}x#{window_height}"]).trim();
    await page.addInitScript((name) => {
      const Native = window.WebSocket;
      const gate = (window as any).__resizeGate = { armed: false, held: null, release: false, delivered: false, cols: 0 };
      window.WebSocket = class extends Native {
        set onmessage(handler) {
          super.onmessage = handler ? function (event) {
            let msg: any;
            if (typeof event.data === "string") { try { msg = JSON.parse(event.data); } catch {} }
            if (gate.armed && !gate.held && this.url.includes(`/ws/sessions/${encodeURIComponent(name)}?`) && msg?.kind === "viewport" && msg.applied) {
              gate.cols = msg.cols;
              gate.held = () => handler.call(this, event);
              return;
            }
            handler.call(this, event);
          } : null;
        }
      };
      // Registered after the terminal's own listener below: deliver the actual
      // old confirmation between its immediate fit and debounced publication.
      (window as any).__installResizeRelease = () => window.addEventListener("resize", () => {
        if (gate.release && gate.held && !gate.delivered) { gate.delivered = true; gate.held(); }
      });
    }, name);
    await page.setViewportSize({ width: 1400, height: 900 });
    await openApp(page);
    await expect(tab(page, name)).toBeVisible({ timeout: 10_000 });
    await tab(page, name).click();
    await expect.poll(size).not.toBe("100x30");
    await page.evaluate(() => { (window as any).__installResizeRelease(); (window as any).__resizeGate.armed = true; });
    await page.setViewportSize({ width: 1200, height: 800 });
    await expect.poll(() => page.evaluate(() => Boolean((window as any).__resizeGate.held))).toBe(true);
    const olderCols = await page.evaluate(() => (window as any).__resizeGate.cols as number);
    await page.evaluate(() => { (window as any).__resizeGate.release = true; });
    await page.setViewportSize({ width: 1000, height: 650 });
    await expect.poll(() => page.evaluate(() => (window as any).__resizeGate.delivered)).toBe(true);
    await expect.poll(() => Number(size().split("x")[0]), { timeout: 5_000 }).toBeLessThan(olderCols);
    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

}
