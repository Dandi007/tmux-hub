import { test, expect } from "./fixtures";
import { bindSecret } from "./helpers";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { holdWebSocketUpgrade } from "./renderer-proxy";

const tab = (page: Page, name: string) => page.locator(`.tab-bar__tab[data-session="${name}"]`);
async function open(page: Page) {
  await page.goto("/?debug=term"); await bindSecret(page); await page.reload();
}
async function gate(page: Page, armed: boolean, target = "", proxyPort = 0, holdViewport = false) {
  await page.addInitScript(({ armed, target, proxyPort, holdViewport }) => {
    const schedule = window.setTimeout;
    const g = (window as any).__rendererGate = { armed, callbacks: [] as { phase: number; run: () => void }[], messages: [] as unknown[], sockets: [] as WebSocket[], holdRetry: false, holdActivity: false, heldActivity: [] as (() => void)[], holdViewport, heldViewport: [] as (() => void)[] };
    window.setTimeout = ((fn: TimerHandler, delay?: number, ...args: unknown[]) => {
      const source = typeof fn === "function" ? String(fn) : "";
      const host = Array.from(document.querySelectorAll(".terminal-host")).at(-1);
      const current = host?.closest<HTMLElement>(".term-slot")?.dataset.session;
      if (g.holdRetry && typeof fn === "function" && delay! >= 350 && delay! <= 650) {
        g.callbacks.push({ phase: 500, run: () => fn(...args) });
        return schedule(() => {}, 60_000);
      }
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
        if (decodeURIComponent(u.pathname.split("/").at(-1)!) === target) g.sockets.push(this);
      }
      set onmessage(handler) {
        super.onmessage = handler ? function (event) {
          if (typeof event.data === "string") {
            try {
              const m = JSON.parse(event.data);
              if (m.kind === "viewport") {
                g.messages.push({ at: performance.now(), name: new URL(this.url).pathname.split("/").at(-1), ...m });
                if (g.holdViewport) { g.heldViewport.push(Object.assign(() => handler.call(this, event), { message: m })); return; }
              }
            } catch {}
          }
          handler.call(this, event);
        } : null;
      }
    };
    const Events = window.EventSource;
    window.EventSource = class extends Events {
      set onmessage(handler) {
        super.onmessage = handler ? function (event) {
          const m = JSON.parse(event.data);
          if (g.holdActivity && m.event === "session_activity" && m.payload.name === target) { g.heldActivity.push(() => handler.call(this, event)); return; }
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
  }, { armed, target, proxyPort, holdViewport });
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
        return { count, size: t.measuredSize ?? `${t.cols}x${t.rows}`, visible: t.visible, replays: t.replays };
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

  for (const initiallyPinned of [true, false]) test(`visible renderer measurement survives CONNECTING then a tab switch: ${initiallyPinned ? "pinned" : "hidden activation"}`, async ({ page, ctx }, info) => {
    const a = await ctx.createSession(), b = await ctx.createSession();
    const proxy = await holdWebSocketUpgrade(Number(ctx.port));
    const pane = () => ctx.tmuxE2E(["display", "-p", "-t", b, "#{pane_width}x#{pane_height}"]);
    try {
      await gate(page, true, b, proxy.port);
      await page.addInitScript(n => localStorage.setItem("tmux-hub.last-session", n), initiallyPinned ? b : a);
      await page.setViewportSize({ width: 1400, height: 900 }); await open(page);
      await expect(tab(page, b)).toBeVisible();
      await page.reload(); // Restore B from a registry snapshot containing both owned sessions.
      await expect.poll(() => page.evaluate(() => (window as any).__rendererGate.callbacks.filter((x: any) => x.phase === 50).length)).toBe(1);
      await expect.poll(() => proxy.buffered()).toBeGreaterThan(0);
      await tab(page, b).click();
      expect(await page.evaluate(() => (window as any).__rendererGate.sockets[0]?.readyState)).toBe(0);
      const before = await view(page, b);
      await expect.poll(() => pane()).toBe(initiallyPinned ? before!.size : "80x24");
      const measured = await page.evaluate(n => {
        const count = (window as any).__fireRenderer(50), t = window.__tmuxHubTerms![n]!;
        return { count, size: t.measuredSize ?? `${t.cols}x${t.rows}`, visible: t.visible, replays: t.replays };
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
  for (const timing of ["after", "before", "between"] as const) test(`own applied acknowledgement restores permission after an older peer notice: renderer ${timing} ack`, async ({ page, ctx }, info) => {
    const beforeAck = timing !== "after";
    const name = await ctx.createSession();
    const pane = () => ctx.tmuxE2E(["display", "-p", "-t", name, "#{pane_width}x#{pane_height}"]);
    await gate(page, true, name); await page.setViewportSize({ width: 1400, height: 900 }); await open(page);
    await tab(page, name).click();
    await expect.poll(async () => (await view(page, name))?.replays ?? 0).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => (window as any).__rendererGate.callbacks.filter((x: any) => x.phase === 50).length)).toBe(1);
    if (!beforeAck) await page.evaluate(() => { (window as any).__rendererGate.holdViewport = true; });
    const peer = await page.context().newPage();
    try {
      await peer.setViewportSize({ width: 1200, height: 800 }); await open(peer); await tab(peer, name).click();
      await expect.poll(async () => (await view(peer, name))?.replays ?? 0).toBeGreaterThan(0);
      await peer.waitForTimeout(350);
      if (beforeAck) {
        await expect.poll(async () => (await view(page, name))?.size).toBe(pane());
        await page.evaluate(() => { (window as any).__rendererGate.holdViewport = true; });
        await peer.setViewportSize({ width: 1100, height: 750 });
        await expect.poll(() => pane()).not.toBe("169x42");
      }
      const peerSize = pane();
      await page.setViewportSize({ width: 1300, height: 850 });
      await expect.poll(() => pane()).not.toBe(peerSize);
      const local = (await view(page, name))!.size;
      await expect.poll(() => page.evaluate(({ name, local }) => (window as any).__rendererGate.messages.some((m: any) => m.name === name && m.applied && `${m.cols}x${m.rows}` === local), { name, local })).toBe(true);
      const deliver = () => page.evaluate(() => {
        const g = (window as any).__rendererGate; g.holdViewport = false;
        for (const deliver of g.heldViewport.splice(0)) deliver();
      });
      if (!beforeAck) await deliver();
      if (timing === "between") await page.evaluate(() => {
        const g = (window as any).__rendererGate, pending = [];
        for (const callback of g.heldViewport) {
          if (callback.message.peer) callback(); else pending.push(callback);
        }
        g.heldViewport = pending;
      });
      const measured = await page.evaluate(n => {
        const count = (window as any).__fireRenderer(50), t = window.__tmuxHubTerms![n]!;
        return { count, size: t.measuredSize ?? `${t.cols}x${t.rows}` };
      }, name);
      if (beforeAck) await deliver();
      expect(measured.count).toBe(1); expect(measured.size).not.toBe(local);
      writeFileSync(info.outputPath("own-applied-renderer.json"), JSON.stringify({ peerSize, local, measured, messages: await page.evaluate(() => (window as any).__rendererGate.messages) }));
      await expect.poll(() => pane()).toBe(measured.size);
      await expect.poll(async () => (await view(peer, name))?.size).toBe(measured.size);
    } finally { await page.screenshot({ path: info.outputPath("own-applied-renderer.png") }).catch(() => {}); await peer.close(); }
  });

  for (const attempt of ["initial", "reconnect", "refresh-resize"] as const) test(`${attempt} open does not override a peer pin completed during its handshake`, async ({ page, ctx }, info) => {
    const reconnect = attempt !== "initial";
    let releaseAuth = () => {};
    const name = await ctx.createSession(), proxy = await holdWebSocketUpgrade(Number(ctx.port));
    const pane = () => ctx.tmuxE2E(["display", "-p", "-t", name, "#{pane_width}x#{pane_height}"]);
    const peer = await page.context().newPage();
    try {
      proxy.release(); await gate(page, false, name, proxy.port);
      await page.setViewportSize({ width: 1400, height: 900 }); await open(page); await tab(page, name).click();
      await expect.poll(async () => (await view(page, name))?.replays ?? 0).toBeGreaterThan(0);
      await page.waitForTimeout(350);
      await peer.setViewportSize({ width: 1200, height: 800 }); await open(peer); await tab(peer, name).click();
      await expect.poll(async () => (await view(peer, name))?.replays ?? 0).toBeGreaterThan(0); await peer.waitForTimeout(350);
      await page.setViewportSize({ width: 1300, height: 850 });
      await expect.poll(async () => (await view(page, name))?.size === pane()).toBe(true);
      const before = (await view(page, name))!;
      let authReached = Promise.resolve();
      if (attempt === "refresh-resize") {
        let reached!: () => void;
        authReached = new Promise<void>(resolve => { reached = resolve; });
        const held = new Promise<void>(resolve => { releaseAuth = resolve; });
        await page.route("**/system/auth-check", async route => { reached(); await held; await route.continue(); });
      }
      proxy.hold();
      if (reconnect) await page.evaluate(n => window.__tmuxHubTerms![n]!.dropSocket(), name);
      else await page.reload();
      if (attempt === "refresh-resize") {
        await authReached;
        await page.setViewportSize({ width: 1000, height: 700 });
        await expect.poll(async () => (await view(page, name))?.size).not.toBe(before.size);
        releaseAuth();
      }
      await expect.poll(() => page.evaluate(() => (window as any).__rendererGate.sockets.length)).toBe(reconnect ? 2 : 1);
      await expect.poll(() => proxy.buffered()).toBeGreaterThan(0);
      const connecting = await page.evaluate(() => {
        const socket = (window as any).__rendererGate.sockets.at(-1), url = new URL(socket.url);
        return { size: `${url.searchParams.get("cols")}x${url.searchParams.get("rows")}`, ready: socket.readyState };
      });
      await expect.poll(() => pane()).toBe(connecting.size);
      expect(connecting.ready).toBe(0);
      await peer.setViewportSize({ width: 1100, height: 750 });
      await expect.poll(() => pane()).not.toBe(connecting.size);
      await expect.poll(async () => (await view(peer, name))?.size === pane()).toBe(true);
      const expected = pane(); proxy.release();
      await expect.poll(async () => { const p = await view(page, name); return p?.replays! > (reconnect ? before.replays : 0) && (await page.evaluate(n => window.__tmuxHubTerms![n]!.state, name)) === "connected"; }).toBe(true);
      await page.waitForTimeout(250);
      await expect.poll(async () => ({ a: (await view(page, name))?.size, b: (await view(peer, name))?.size, pane: pane() })).toEqual({ a: expected, b: expected, pane: expected });
      writeFileSync(info.outputPath("reconnect-peer.json"), JSON.stringify({ before, expected, messages: await page.evaluate(() => (window as any).__rendererGate.messages) }));
    } finally { releaseAuth(); await page.screenshot({ path: info.outputPath("reconnect-peer.png") }).catch(() => {}); await peer.close(); await proxy.close(); }
  });

  test("activation during reconnect backoff reaches the pane after switching away", async ({ page, ctx }, info) => {
    const a = await ctx.createSession(), b = await ctx.createSession();
    const pane = () => ctx.tmuxE2E(["display", "-p", "-t", b, "#{pane_width}x#{pane_height}"]);
    await gate(page, false, b); await page.setViewportSize({ width: 1400, height: 900 }); await open(page);
    await tab(page, b).click(); await expect.poll(async () => (await view(page, b))?.replays ?? 0).toBeGreaterThan(0);
    await page.waitForTimeout(350); await expect.poll(async () => (await view(page, b))?.size === pane()).toBe(true);
    const old = pane(); await tab(page, a).click(); await page.setViewportSize({ width: 1000, height: 700 });
    await page.evaluate(n => { (window as any).__rendererGate.holdRetry = true; window.__tmuxHubTerms![n]!.dropSocket(); }, b);
    await expect.poll(() => page.evaluate(() => (window as any).__rendererGate.callbacks.filter((x: any) => x.phase === 500).length)).toBe(1);
    await tab(page, b).click(); const measured = (await view(page, b))!.size; expect(measured).not.toBe(old);
    await tab(page, a).click();
    expect(await page.evaluate(() => (window as any).__rendererGate.sockets.length)).toBe(1);
    await page.evaluate(() => { (window as any).__rendererGate.holdRetry = false; (window as any).__fireRenderer(500); });
    await expect.poll(() => page.evaluate(n => window.__tmuxHubTerms![n]!.state, b)).toBe("connected");
    writeFileSync(info.outputPath("backoff-activation.json"), JSON.stringify({ old, measured, pane: pane(), messages: await page.evaluate(() => (window as any).__rendererGate.messages) }));
    await expect.poll(() => pane()).toBe(measured);
    expect((await view(page, b))?.visible).toBe(false);
    await page.screenshot({ path: info.outputPath("backoff-activation.png") });
  });

  test("native-era renderer measurement cannot overwrite a fresh reconnect URL grid", async ({ page, ctx }, info) => {
    const name = await ctx.createSession();
    const pane = () => ctx.tmuxE2E(["display", "-p", "-t", name, "#{pane_width}x#{pane_height}"]);
    const attached = () => Number(ctx.tmuxE2E(["display", "-p", "-t", name, "#{session_attached}"]));
    const env = { ...process.env, TMUX_TMPDIR: ctx.tmuxTmpdir, TERM: "xterm-256color" }; delete env.TMUX;
    const args = process.platform === "linux"
      ? ["-q", "-c", `tmux -L ${ctx.socket} attach -t ${name}`, "/dev/null"]
      : ["-q", "/dev/null", "tmux", "-L", ctx.socket, "attach", "-t", name];
    const native = spawn("script", args, { env, stdio: ["pipe", "ignore", "ignore"] });
    try {
      await expect.poll(attached).toBeGreaterThan(0);
      await gate(page, true, name, 0, true); await page.setViewportSize({ width: 1400, height: 900 }); await open(page); await tab(page, name).click();
      await expect.poll(() => page.evaluate(() => (window as any).__rendererGate.callbacks.filter((x: any) => x.phase === 50).length)).toBe(1);
      await expect.poll(() => page.evaluate(() => (window as any).__rendererGate.messages.some((m: any) => m.owner === "native"))).toBe(true);
      const measured = await page.evaluate(n => { (window as any).__fireRenderer(50); return window.__tmuxHubTerms![n]!.measuredSize; }, name);
      await page.evaluate(() => { const g = (window as any).__rendererGate; g.holdViewport = false; for (const deliver of g.heldViewport.splice(0)) deliver(); });
      await expect.poll(async () => (await view(page, name))?.size).toBe(pane());
      await page.setViewportSize({ width: 1000, height: 700 });
      const current = await page.evaluate(n => window.__tmuxHubTerms![n]!.measuredSize, name); expect(current).not.toBe(measured);
      const nativeViewport = { browser: (await view(page, name))?.size, pane: pane(), attached: attached() };
      await page.evaluate(n => { const g = (window as any).__rendererGate; g.holdActivity = true; g.holdRetry = true; window.__tmuxHubTerms![n]!.dropSocket(); }, name);
      await expect.poll(() => page.evaluate(() => (window as any).__rendererGate.callbacks.filter((x: any) => x.phase === 500).length)).toBe(1);
      ctx.tmuxE2E(["detach-client", "-s", name]); await expect.poll(attached).toBe(0);
      await page.evaluate(() => { const g = (window as any).__rendererGate; g.holdRetry = false; (window as any).__fireRenderer(500); });
      await expect.poll(() => page.evaluate(n => window.__tmuxHubTerms![n]!.state, name)).toBe("connected");
      await page.waitForTimeout(250);
      writeFileSync(info.outputPath("native-renderer.json"), JSON.stringify({ measured, current, nativeViewport, pane: pane(), messages: await page.evaluate(() => (window as any).__rendererGate.messages) }));
      await expect.poll(() => pane()).toBe(current);
      await expect.poll(async () => (await view(page, name))?.size).toBe(current);
      await page.evaluate(() => { const g = (window as any).__rendererGate; g.holdActivity = false; for (const deliver of g.heldActivity.splice(0)) deliver(); });
      await page.waitForTimeout(250); expect(pane()).toBe(current);
      await page.screenshot({ path: info.outputPath("native-renderer.png") });
    } finally {
      if (attached() > 0) ctx.tmuxE2E(["detach-client", "-s", name]);
      if (native.exitCode === null) await new Promise<void>(resolve => { native.once("exit", () => resolve()); native.kill(); });
    }
  });

}
