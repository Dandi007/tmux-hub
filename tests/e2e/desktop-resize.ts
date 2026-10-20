import { test, expect } from "./fixtures";
import { bindSecret } from "./helpers";
import type { Page } from "@playwright/test";

const tab = (page: Page, name: string) => page.locator(`.tab-bar__tab[data-session="${name}"]`);
async function openApp(page: Page): Promise<void> {
  await page.goto("/?debug=term"); await bindSecret(page); await page.reload();
}

export function defineResizeAcknowledgementTest(): void {
  test("resize fits the current window after an older applied acknowledgement arrives", async ({ page, ctx }) => {
    const name = await ctx.createSession();
    const size = () => ctx.tmuxE2E(["display", "-p", "-t", name, "#{window_width}x#{window_height}"]).trim();
    await page.addInitScript((name) => {
      const Native = window.WebSocket;
      const gate = (window as any).__resizeGate = { armed: false, held: null, release: false, delivered: false, cols: 0, initialCols: 0, ack: "", target: "" };
      window.WebSocket = class extends Native {
        set onmessage(handler) {
          super.onmessage = handler ? function (event) {
            let msg: any;
            if (typeof event.data === "string") { try { msg = JSON.parse(event.data); } catch {} }
            if (this.url.includes(`/ws/sessions/${encodeURIComponent(name)}?`) && msg?.kind === "viewport" && msg.applied) {
              if (!gate.armed || gate.held || msg.cols >= gate.initialCols) {
                gate.ack = `${msg.cols}x${msg.rows}`; handler.call(this, event); return;
              }
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
        if (gate.release && gate.held && !gate.delivered) {
          const p = window.__tmuxHubTerms![name]!;
          gate.target = `${p.cols}x${p.rows}`;
          gate.delivered = true; gate.held();
        }
      });
    }, name);
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
    await page.setViewportSize({ width: 1200, height: 800 });
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
    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

  test("a peer takeover cancels an older debounced window resize", async ({ page, ctx }) => {
    const name = await ctx.createSession();
    const other = await ctx.createSession();
    const size = () => ctx.tmuxE2E(["display", "-p", "-t", name, "#{window_width}x#{window_height}"]).trim();
    const grid = (p: Page) => p.evaluate(n => {
      const t = window.__tmuxHubTerms?.[n]; return t ? `${t.cols}x${t.rows}` : "";
    }, name);
    await page.addInitScript(() => {
      const schedule = window.setTimeout, cancel = window.clearTimeout;
      const gate = (window as any).__publication = { armed: false, pending: new Map<number, { run: () => void }>() };
      window.setTimeout = ((fn: TimerHandler, delay?: number, ...args: any[]) => {
        if (gate.armed && delay === 150 && typeof fn === "function") {
          const id = schedule(() => {}, 60_000);
          gate.pending.set(id, { run: () => fn(...args) }); return id;
        }
        return schedule(fn, delay, ...args);
      }) as typeof window.setTimeout;
      window.clearTimeout = (id) => {
        gate.pending.delete(id);
        cancel(id);
      };
      (window as any).__releasePublication = () => {
        gate.armed = false; const entries = [...gate.pending]; gate.pending.clear();
        for (const [id, p] of entries) { cancel(id); p.run(); }
      };
    });
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
      await page.evaluate(() => { (window as any).__publication.armed = true; });
      await page.setViewportSize({ width: 1000, height: 650 });
      await expect.poll(() => page.evaluate(() => (window as any).__publication.pending.size > 0)).toBe(true);
      // Real tab activation publishes immediately: B takes ownership after A's
      // fit and before the held A timer can run. No viewport messages invented.
      await tab(peer, other).click(); await tab(peer, name).click();
      const target = await grid(peer);
      await expect.poll(async () => ({ a: await grid(page), b: await grid(peer), pane: size() }))
        .toEqual({ a: target, b: target, pane: target });
      // Let B's own 150ms publication settle before releasing A's old timer,
      // so a later B retry cannot mask A incorrectly stealing ownership.
      await peer.waitForTimeout(350);
      await page.evaluate(() => (window as any).__releasePublication());
      await page.waitForTimeout(350);
      expect({ a: await grid(page), b: await grid(peer), pane: size() }).toEqual({ a: target, b: target, pane: target });
    } finally { await peer.close(); }
    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

}
