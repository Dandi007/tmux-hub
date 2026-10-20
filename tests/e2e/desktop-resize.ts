import { test, expect } from "./fixtures";
import { bindSecret } from "./helpers";
import type { Page } from "@playwright/test";

const tab = (page: Page, name: string) => page.locator(`.tab-bar__tab[data-session="${name}"]`);
async function openApp(page: Page): Promise<void> {
  await page.goto("/?debug=term"); await bindSecret(page); await page.reload();
}

export function defineResizeAcknowledgementTest(): void {
  for (const source of ["applied", "peer"] as const) test(`resize fits the current window after an older ${source} acknowledgement arrives`, async ({ page, ctx }) => {
    const name = await ctx.createSession();
    const size = () => ctx.tmuxE2E(["display", "-p", "-t", name, "#{window_width}x#{window_height}"]).trim();
    await page.addInitScript(({ name, source }) => {
      const Native = window.WebSocket;
      const gate = (window as any).__resizeGate = { armed: false, held: null, release: false, delivered: false, cols: 0, initialCols: 0, ack: "", target: "" };
      window.WebSocket = class extends Native {
        set onmessage(handler) {
          super.onmessage = handler ? function (event) {
            let msg: any;
            if (typeof event.data === "string") { try { msg = JSON.parse(event.data); } catch {} }
            if (this.url.includes(`/ws/sessions/${encodeURIComponent(name)}?`) && msg?.kind === "viewport") {
              const hold = gate.armed && !gate.held && (source === "applied"
                ? msg.applied && msg.cols < gate.initialCols : msg.peer);
              if (hold) {
                gate.cols = msg.cols; gate.held = () => handler.call(this, event); return;
              }
              if (msg.applied) gate.ack = `${msg.cols}x${msg.rows}`;
            }
            handler.call(this, event);
          } : null;
        }
      };
      // Registered after the terminal's own listener below: deliver the actual
      // old confirmation between its immediate fit and debounced publication.
      (window as any).__installResizeRelease = () => window.addEventListener("resize", () => {
        if (gate.release && gate.held && !gate.delivered) {
          const p = window.__tmuxHubTerms![name]!;
          gate.target = `${p.cols}x${p.rows}`;
          gate.delivered = true; gate.held();
        }
      });
    }, { name, source });
    await page.setViewportSize({ width: 1400, height: 900 });
    await openApp(page);
    await expect(tab(page, name)).toBeVisible({ timeout: 10_000 });
    await tab(page, name).click();
    await expect.poll(async () => {
      const { grid, ack, ready } = await page.evaluate(n => {
        const p = window.__tmuxHubTerms?.[n];
        return { grid: p ? `${p.cols}x${p.rows}` : "", ack: (window as any).__resizeGate.ack, ready: Boolean(p?.replays) };
      }, name);
      return ready && grid === ack && grid === size();
    }).toBe(true);
    await page.evaluate(n => {
      const g = (window as any).__resizeGate;
      g.initialCols = window.__tmuxHubTerms![n]!.cols;
      (window as any).__installResizeRelease(); g.armed = true;
    }, name);
    const peer = source === "peer" ? await page.context().newPage() : null;
    if (peer) {
      await peer.setViewportSize({ width: 1200, height: 800 }); await openApp(peer);
      await expect(tab(peer, name)).toBeVisible({ timeout: 10_000 }); await tab(peer, name).click();
      await expect.poll(() => peer.evaluate(n => Boolean(window.__tmuxHubTerms?.[n]?.replays), name)).toBe(true);
      // B's older initial pin and 100/150ms compensation must be complete
      // before A's newer window operation; only its real peer notice is held.
      await peer.waitForTimeout(350);
    } else await page.setViewportSize({ width: 1200, height: 800 });
    await expect.poll(() => page.evaluate(() => Boolean((window as any).__resizeGate.held))).toBe(true);
    const olderCols = await page.evaluate(() => (window as any).__resizeGate.cols as number);
    await page.evaluate(() => { (window as any).__resizeGate.release = true; });
    await page.setViewportSize({ width: 1000, height: 650 });
    await expect.poll(() => page.evaluate(() => (window as any).__resizeGate.delivered)).toBe(true);
    const target = await page.evaluate(() => (window as any).__resizeGate.target as string);
    expect(Number(target.split("x")[0])).toBeLessThan(olderCols);
    await expect.poll(async () => {
      const client = await page.evaluate(n => {
        const p = window.__tmuxHubTerms![n]!;
        return { grid: `${p.cols}x${p.rows}`, ack: (window as any).__resizeGate.ack };
      }, name);
      return { ...client, pane: size() };
    }, { timeout: 5_000 }).toEqual({ grid: target, ack: target, pane: target });
    if (peer) {
      await expect.poll(() => peer.evaluate(n => {
        const p = window.__tmuxHubTerms![n]!; return `${p.cols}x${p.rows}`;
      }, name)).toBe(target);
      await peer.close();
    }
    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("a newer peer activation keeps its viewport after a window resize", async ({ page, ctx }) => {
    const name = await ctx.createSession();
    const other = await ctx.createSession();
    const size = () => ctx.tmuxE2E(["display", "-p", "-t", name, "#{window_width}x#{window_height}"]).trim();
    const grid = (p: Page) => p.evaluate(n => {
      const t = window.__tmuxHubTerms?.[n]; return t ? `${t.cols}x${t.rows}` : "";
    }, name);
    await page.setViewportSize({ width: 1400, height: 900 }); await openApp(page);
    await expect(tab(page, name)).toBeVisible({ timeout: 10_000 }); await tab(page, name).click();
    await expect.poll(() => grid(page)).not.toBe("");
    const peer = await page.context().newPage();
    try {
      await peer.setViewportSize({ width: 1200, height: 800 }); await openApp(peer);
      await expect(tab(peer, name)).toBeVisible({ timeout: 10_000 }); await tab(peer, name).click();
      await expect.poll(async () => (await grid(peer)) === size()).toBe(true);
      await page.waitForTimeout(350);
      // Establish A as the current pinner first; otherwise B's same-size pin
      // would be a server no-op and generate no peer takeover notification.
      await tab(page, other).click(); await tab(page, name).click();
      const initial = await grid(page);
      await expect.poll(async () => ({ a: await grid(page), b: await grid(peer), pane: size() }))
        .toEqual({ a: initial, b: initial, pane: initial });
      await page.waitForTimeout(350);
      await page.setViewportSize({ width: 1000, height: 650 });
      const current = await grid(page);
      await expect.poll(async () => ({ a: await grid(page), b: await grid(peer), pane: size() }))
        .toEqual({ a: current, b: current, pane: current });
      // A's real resize is applied; B's later real tab activation takes over.
      await tab(peer, other).click(); await tab(peer, name).click();
      const target = await grid(peer);
      await expect.poll(async () => ({ a: await grid(page), b: await grid(peer), pane: size() }))
        .toEqual({ a: target, b: target, pane: target });
      await peer.waitForTimeout(350);
      expect({ a: await grid(page), b: await grid(peer), pane: size() }).toEqual({ a: target, b: target, pane: target });
    } finally { await peer.close(); }
    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

}
