import { test, expect } from "./fixtures";
import { bindSecret } from "./helpers";
import type { Page } from "@playwright/test";

const tab = (page: Page, name: string) => page.locator(`.tab-bar__tab[data-session="${name}"]`);
async function openApp(page: Page): Promise<void> {
  await page.goto("/?debug=term"); await bindSecret(page); await page.reload();
}

export function defineResizeAcknowledgementTest(): void {
  for (const source of ["applied", "peer", "pool"] as const) test(`resize fits the current window after an older ${source} acknowledgement arrives`, async ({ page, ctx }) => {
    const name = await ctx.createSession();
    const size = () => ctx.tmuxE2E(["display", "-p", "-t", name, "#{window_width}x#{window_height}"]).trim();
    await page.addInitScript(({ name, source }) => {
      const Native = window.WebSocket;
      const gate = (window as any).__resizeGate = { armed: false, held: null, release: false, delivered: false, cols: 0, initialCols: 0, ack: "", target: "", late: [], flush: false };
      if (source === "pool") {
        const schedule = window.setTimeout, cancel = window.clearTimeout;
        const timers = new Map<number, () => void>();
        window.setTimeout = ((fn: TimerHandler, delay?: number, ...args: any[]) => {
          if (gate.armed && delay === 150 && typeof fn === "function") {
            const id = schedule(() => {}, 60_000); timers.set(id, () => fn(...args)); return id;
          }
          return schedule(fn, delay, ...args);
        }) as typeof window.setTimeout;
        window.clearTimeout = id => { timers.delete(id!); cancel(id); };
        (window as any).__fireOldCompensation = () => {
          const entries = [...timers]; timers.clear();
          for (const [id, run] of entries) { cancel(id); run(); }
        };
      }
      window.WebSocket = class extends Native {
        set onmessage(handler) {
          super.onmessage = handler ? function (event) {
            let msg: any;
            if (typeof event.data === "string") { try { msg = JSON.parse(event.data); } catch {} }
            if (this.url.includes(`/ws/sessions/${encodeURIComponent(name)}?`) && msg?.kind === "viewport") {
              if (source === "pool" && gate.delivered && !gate.flush && msg.applied) {
                gate.late.push(() => { gate.ack = `${msg.cols}x${msg.rows}`; handler.call(this, event); }); return;
              }
              const hold = gate.armed && !gate.held && (source !== "peer"
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
    } else if (source === "pool") {
      const other = await ctx.createSession();
      await expect(tab(page, other)).toBeVisible({ timeout: 10_000 });
      await tab(page, other).click();
      await page.setViewportSize({ width: 1200, height: 800 });
      await tab(page, name).click();
    } else await page.setViewportSize({ width: 1200, height: 800 });
    await expect.poll(() => page.evaluate(() => Boolean((window as any).__resizeGate.held))).toBe(true);
    const olderCols = await page.evaluate(() => (window as any).__resizeGate.cols as number);
    await page.evaluate(() => { (window as any).__resizeGate.release = true; });
    await page.setViewportSize({ width: 1000, height: 650 });
    await expect.poll(() => page.evaluate(() => (window as any).__resizeGate.delivered)).toBe(true);
    const target = await page.evaluate(() => (window as any).__resizeGate.target as string);
    expect(Number(target.split("x")[0])).toBeLessThan(olderCols);
    if (source === "pool") {
      // Keep actual newer acknowledgements in wire order until the old pool
      // compensation would have fired. No dimensions or messages are invented.
      await page.evaluate(() => (window as any).__fireOldCompensation());
      await page.waitForTimeout(350);
      await page.evaluate(() => {
        const g = (window as any).__resizeGate; g.flush = true;
        for (const deliver of g.late) deliver(); g.late = [];
      });
    }
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
    await expect.poll(async () => {
      const g = await grid(page); return g !== "" && g === size();
    }).toBe(true);
    let original = await grid(page);
    const [oc, or] = original.split("x").map(Number);
    const peer = await page.context().newPage();
    try {
      await peer.setViewportSize({ width: 1200, height: 800 }); await openApp(peer);
      await expect(tab(peer, name)).toBeVisible({ timeout: 10_000 }); await tab(peer, name).click();
      await expect.poll(async () => (await grid(peer)) === size()).toBe(true);
      await peer.waitForTimeout(350);
      const peerExpected = await grid(peer);
      const [pc, pr] = peerExpected.split("x").map(Number);
      expect(pc).toBeLessThan(oc!); expect(pr).toBeLessThan(or!);
      expect(size()).toBe(peerExpected);
      // Establish A as the current pinner first; otherwise B's same-size pin
      // would be a server no-op and generate no peer takeover notification.
      await page.evaluate(n => {
        const slot = document.querySelector(`.term-slot[data-session="${n}"]`)!;
        (window as any).__activationGrid = "";
        const observer = new MutationObserver(() => {
          if (!slot.classList.contains("is-active")) return;
          const p = window.__tmuxHubTerms![n]!;
          (window as any).__activationGrid = `${p.cols}x${p.rows}`;
          observer.disconnect();
        });
        observer.observe(slot, { attributes: true, attributeFilter: ["class"] });
      }, name);
      await tab(page, other).click(); await tab(page, name).click();
      await expect.poll(() => page.evaluate(() => (window as any).__activationGrid)).not.toBe("");
      original = await page.evaluate(() => (window as any).__activationGrid as string);
      await expect.poll(async () => ({ a: await grid(page), b: await grid(peer), pane: size() }))
        .toEqual({ a: original, b: original, pane: original });
      await page.waitForTimeout(350);
      await page.evaluate(n => {
        (window as any).__newWindowGrid = "";
        window.addEventListener("resize", () => {
          const p = window.__tmuxHubTerms![n]!;
          (window as any).__newWindowGrid = `${p.cols}x${p.rows}`;
        }, { once: true });
      }, name);
      await page.setViewportSize({ width: 1000, height: 650 });
      await expect.poll(() => page.evaluate(() => (window as any).__newWindowGrid)).not.toBe("");
      const current = await page.evaluate(() => (window as any).__newWindowGrid as string);
      await expect.poll(async () => ({ a: await grid(page), b: await grid(peer), pane: size() }))
        .toEqual({ a: current, b: current, pane: current });
      // A's real resize is applied; B's later real tab activation takes over.
      await tab(peer, other).click(); await tab(peer, name).click();
      const target = peerExpected;
      const [ac, ar] = current.split("x").map(Number);
      const [bc, br] = target.split("x").map(Number);
      expect(bc).toBeGreaterThan(ac!); expect(br).toBeGreaterThan(ar!);
      await expect.poll(async () => ({ a: await grid(page), b: await grid(peer), pane: size() }))
        .toEqual({ a: target, b: target, pane: target });
      await peer.waitForTimeout(350);
      expect({ a: await grid(page), b: await grid(peer), pane: size() }).toEqual({ a: target, b: target, pane: target });
    } finally { await peer.close(); }
    ctx.tmuxE2E(["kill-session", "-t", name]);
  });

}
