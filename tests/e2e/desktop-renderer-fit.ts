import { test, expect } from "./fixtures";
import { bindSecret } from "./helpers";
import { writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { holdWebSocketUpgrade } from "./renderer-proxy";

const tab = (page: Page, name: string) => page.locator(`.tab-bar__tab[data-session="${name}"]`);
async function open(page: Page) {
  await page.goto("/?debug=term"); await bindSecret(page); await page.reload();
}
async function gate(page: Page, armed: boolean, target = "", proxyPort = 0) {
  await page.addInitScript(({ armed, target, proxyPort }) => {
    const schedule = window.setTimeout;
    const g = (window as any).__rendererGate = { armed, callbacks: [] as { phase: number; run: () => void }[], messages: [] as unknown[], sockets: [] as WebSocket[], holdViewport: false, heldViewport: [] as (() => void)[] };
    window.setTimeout = ((fn: TimerHandler, delay?: number, ...args: unknown[]) => {
      const source = typeof fn === "function" ? String(fn) : "";
      const host = Array.from(document.querySelectorAll(".terminal-host")).at(-1);
      const current = host?.closest<HTMLElement>(".term-slot")?.dataset.session;
      if (g.armed && typeof fn === "function" && ((delay === 50 && (!target || current === target) && source.includes("CanvasAddon")) || (delay === 100 && source.includes("readyState")))) {
        g.callbacks.push({ phase: delay!, run: () => fn(...args) });
        return schedule(() => {}, 60_000);
      }
      return schedule(fn, delay, ...args);
    }) as typeof window.setTimeout;
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        const u = new URL(url);
        if (proxyPort && decodeURIComponent(u.pathname.split("/").at(-1)!) === target) u.port = String(proxyPort);
        super(u, protocols);
        if (proxyPort && u.port === String(proxyPort)) g.sockets.push(this);
      }
      set onmessage(handler) {
        super.onmessage = handler ? function (event) {
          if (typeof event.data === "string") {
            try {
              const m = JSON.parse(event.data);
              if (m.kind === "viewport") {
                g.messages.push({ at: performance.now(), name: new URL(this.url).pathname.split("/").at(-1), ...m });
                if (g.holdViewport) { g.heldViewport.push(() => handler.call(this, event)); return; }
              }
            } catch {}
          }
          handler.call(this, event);
        } : null;
      }
    };
    (window as any).__fireRenderer = (phase: number) => {
      const tasks = g.callbacks.filter((t: any) => t.phase === phase);
      g.callbacks = g.callbacks.filter((t: any) => t.phase !== phase);
      for (const task of tasks) task.run();
      return tasks.length;
    };
  }, { armed, target, proxyPort });
}
const view = (p: Page, name: string) => p.evaluate(n => {
  const t = window.__tmuxHubTerms?.[n];
  return t ? { size: `${t.cols}x${t.rows}`, visible: t.visible, replays: t.replays } : null;
}, name);

export function defineRendererFitTests() {
  test("renderer remeasurement is published before a rapid switch hides the tab", async ({ page, ctx }, info) => {
    const a = await ctx.createSession();
    const pane = (n: string) => ctx.tmuxE2E(["display", "-p", "-t", n, "#{pane_width}x#{pane_height}"]);
    await gate(page, false); await page.setViewportSize({ width: 1400, height: 900 }); await open(page);
    await tab(page, a).click();
    await expect.poll(async () => (await view(page, a))?.replays ?? 0).toBeGreaterThan(0);
    await page.waitForTimeout(350); // A's original startup is outside B's controlled window.
    await page.evaluate(() => { (window as any).__rendererGate.armed = true; });
    const b = await ctx.createSession();
    try {
      await expect(tab(page, b)).toBeVisible();
      await expect.poll(() => page.evaluate(() => (window as any).__rendererGate.callbacks.filter((x: any) => x.phase === 50).length)).toBe(1);
      await expect.poll(async () => (await view(page, b))?.replays ?? 0).toBeGreaterThan(0);
      await tab(page, b).click();
      await expect.poll(async () => (await view(page, b))?.size === pane(b)).toBe(true);
      const before = await view(page, b);
      const measured = await page.evaluate(n => {
        const count = (window as any).__fireRenderer(50);
        const t = window.__tmuxHubTerms![n]!;
        return { count, size: `${t.cols}x${t.rows}`, visible: t.visible, replays: t.replays };
      }, b);
      expect(measured.count).toBe(1);
      expect(measured?.visible).toBe(true);
      expect(measured?.size).not.toBe(before?.size); // Real DOM→canvas metric change, no invented grid.
      await tab(page, a).click();
      await page.evaluate(() => (window as any).__fireRenderer(100));
      writeFileSync(info.outputPath("remeasurement.json"), JSON.stringify({ before, measured, paneBefore: pane(b), messages: await page.evaluate(() => (window as any).__rendererGate.messages) }));
      await expect.poll(() => pane(b)).toBe(measured!.size);
      const hidden = pane(b); await page.setViewportSize({ width: 1000, height: 650 });
      await expect.poll(async () => (await view(page, a))?.size === pane(a)).toBe(true);
      await page.waitForTimeout(350); expect(pane(b)).toBe(hidden);
      await tab(page, b).click();
      await expect.poll(async () => (await view(page, b))?.size === pane(b)).toBe(true);
    } finally { await page.screenshot({ path: info.outputPath("renderer-switch.png") }).catch(() => {}); }
  });

  test("visible renderer measurement survives CONNECTING then a tab switch", async ({ page, ctx }, info) => {
    const a = await ctx.createSession(), b = await ctx.createSession();
    const proxy = await holdWebSocketUpgrade(Number(ctx.port));
    const pane = () => ctx.tmuxE2E(["display", "-p", "-t", b, "#{pane_width}x#{pane_height}"]);
    try {
      await gate(page, true, b, proxy.port);
      await page.addInitScript(n => localStorage.setItem("tmux-hub.last-session", n), b);
      await page.setViewportSize({ width: 1400, height: 900 }); await open(page);
      await expect(tab(page, b)).toBeVisible();
      await page.reload(); // Restore B from a registry snapshot containing both owned sessions.
      await expect.poll(() => page.evaluate(() => (window as any).__rendererGate.callbacks.filter((x: any) => x.phase === 50).length)).toBe(1);
      await expect.poll(() => proxy.buffered()).toBeGreaterThan(0);
      await tab(page, b).click();
      expect(await page.evaluate(() => (window as any).__rendererGate.sockets[0]?.readyState)).toBe(0);
      const before = await view(page, b);
      await expect.poll(() => pane()).toBe(before!.size);
      const measured = await page.evaluate(n => {
        const count = (window as any).__fireRenderer(50), t = window.__tmuxHubTerms![n]!;
        return { count, size: `${t.cols}x${t.rows}`, visible: t.visible, replays: t.replays };
      }, b);
      expect(measured.count).toBe(1); expect(measured.visible).toBe(true);
      expect(measured.size).not.toBe(before?.size);
      await tab(page, a).click();
      proxy.release();
      await expect.poll(async () => (await view(page, b))?.replays ?? 0).toBeGreaterThan(0);
      await page.evaluate(() => (window as any).__fireRenderer(100));
      writeFileSync(info.outputPath("connecting-renderer.json"), JSON.stringify({ before, measured, pane: pane(), messages: await page.evaluate(() => (window as any).__rendererGate.messages) }));
      expect((await view(page, b))?.visible).toBe(false);
      await expect.poll(() => pane()).toBe(measured.size);
    } finally {
      await page.screenshot({ path: info.outputPath("connecting-renderer.png") }).catch(() => {});
      await proxy.close();
    }
  });

  test("late renderer initialization preserves a newer peer viewport until local resize", async ({ page, ctx }, info) => {
    const name = await ctx.createSession();
    const pane = () => ctx.tmuxE2E(["display", "-p", "-t", name, "#{pane_width}x#{pane_height}"]);
    await gate(page, true, name); await page.setViewportSize({ width: 1400, height: 900 }); await open(page);
    await tab(page, name).click();
    await expect.poll(async () => (await view(page, name))?.replays ?? 0).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => (window as any).__rendererGate.callbacks.filter((x: any) => x.phase === 50).length)).toBe(1);
    const peer = await page.context().newPage();
    try {
      await peer.setViewportSize({ width: 1200, height: 800 }); await open(peer); await tab(peer, name).click();
      await expect.poll(async () => (await view(peer, name))?.replays ?? 0).toBeGreaterThan(0);
      await peer.waitForTimeout(350);
      const expected = (await view(peer, name))!.size;
      await expect.poll(async () => ({ a: (await view(page, name))?.size, pane: pane() })).toEqual({ a: expected, pane: expected });
      expect(await page.evaluate(() => (window as any).__fireRenderer(50))).toBe(1);
      await page.evaluate(() => (window as any).__fireRenderer(100));
      writeFileSync(info.outputPath("peer-renderer.json"), JSON.stringify({ expected, client: await view(page, name), pane: pane(), messages: await page.evaluate(() => (window as any).__rendererGate.messages) }));
      await expect.poll(async () => ({ a: (await view(page, name))?.size, b: (await view(peer, name))?.size, pane: pane() }))
        .toEqual({ a: expected, b: expected, pane: expected });
      await page.setViewportSize({ width: 1300, height: 850 });
      await expect.poll(() => pane()).not.toBe(expected);
      await expect.poll(async () => ({ a: (await view(page, name))?.size, b: (await view(peer, name))?.size })).toEqual({ a: pane(), b: pane() });
    } finally { await page.screenshot({ path: info.outputPath("peer-renderer.png") }).catch(() => {}); await peer.close(); }
  });
  test("own applied acknowledgement restores permission after an older peer notice", async ({ page, ctx }, info) => {
    const name = await ctx.createSession();
    const pane = () => ctx.tmuxE2E(["display", "-p", "-t", name, "#{pane_width}x#{pane_height}"]);
    await gate(page, true, name); await page.setViewportSize({ width: 1400, height: 900 }); await open(page);
    await tab(page, name).click();
    await expect.poll(async () => (await view(page, name))?.replays ?? 0).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => (window as any).__rendererGate.callbacks.filter((x: any) => x.phase === 50).length)).toBe(1);
    await page.evaluate(() => { (window as any).__rendererGate.holdViewport = true; });
    const peer = await page.context().newPage();
    try {
      await peer.setViewportSize({ width: 1200, height: 800 }); await open(peer); await tab(peer, name).click();
      await expect.poll(async () => (await view(peer, name))?.replays ?? 0).toBeGreaterThan(0);
      await peer.waitForTimeout(350);
      const peerSize = pane();
      await page.setViewportSize({ width: 1300, height: 850 });
      await expect.poll(() => pane()).not.toBe(peerSize);
      const local = (await view(page, name))!.size;
      await expect.poll(() => page.evaluate(({ name, local }) => (window as any).__rendererGate.messages.some((m: any) => m.name === name && m.applied && `${m.cols}x${m.rows}` === local), { name, local })).toBe(true);
      await page.evaluate(() => {
        const g = (window as any).__rendererGate; g.holdViewport = false;
        for (const deliver of g.heldViewport.splice(0)) deliver();
      });
      const measured = await page.evaluate(n => {
        const count = (window as any).__fireRenderer(50), t = window.__tmuxHubTerms![n]!;
        return { count, size: `${t.cols}x${t.rows}` };
      }, name);
      expect(measured.count).toBe(1); expect(measured.size).not.toBe(local);
      writeFileSync(info.outputPath("own-applied-renderer.json"), JSON.stringify({ peerSize, local, measured, messages: await page.evaluate(() => (window as any).__rendererGate.messages) }));
      await expect.poll(() => pane()).toBe(measured.size);
      await expect.poll(async () => (await view(peer, name))?.size).toBe(measured.size);
    } finally { await page.screenshot({ path: info.outputPath("own-applied-renderer.png") }).catch(() => {}); await peer.close(); }
  });

}
