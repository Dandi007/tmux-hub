import { test, expect } from "./fixtures";
import { bindSecret, waitForRegisteredSessions } from "./helpers";
import { gateNative } from "./native-owner-order";
import { holdWebSocketUpgrade } from "./renderer-proxy";
import { writeFileSync } from "node:fs";

export function defineReconnectBudgetTests() {
  test("successful Upgrades without viewport authority obey retry budget and recover on retry", async ({ page, ctx }, info) => {
    const name = await ctx.createSession(), proxy = await holdWebSocketUpgrade(Number(ctx.port), true);
    proxy.release(); proxy.cutBeforeViewport(true);
    try {
      await gateNative(page, name, false, proxy.port);
      await page.addInitScript(n => {
        const g = (window as any).__retryBudget = { inClose: false, opens: 0, delays: [] as number[] };
        const schedule = window.setTimeout;
        window.setTimeout = ((fn: TimerHandler, delay?: number, ...args: unknown[]) => {
          if (g.inClose && typeof fn === "function" && delay! >= 300 && delay! <= 60_000) {
            g.delays.push(delay!); return schedule(fn, 15, ...args);
          }
          return schedule(fn, delay, ...args);
        }) as typeof window.setTimeout;
        const W = window.WebSocket;
        window.WebSocket = class extends W {
          constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            if (decodeURIComponent(new URL(url).pathname.split("/").at(-1)!) === n) this.addEventListener("open", () => g.opens++);
          }
          set onclose(handler) {
            super.onclose = handler ? function(event) {
              const own = decodeURIComponent(new URL(this.url).pathname.split("/").at(-1)!) === n;
              if (own) g.inClose = true;
              try { handler.call(this, event); } finally { g.inClose = false; }
            } : null;
          }
        };
      }, name);
      await page.goto("/system/health"); await bindSecret(page); await waitForRegisteredSessions(page, [name]);
      await page.evaluate(n => localStorage.setItem("tmux-hub.last-session", n), name);
      await page.goto("/?debug=term");
      await expect.poll(() => page.evaluate(n => window.__tmuxHubTerms?.[n]?.state, name)).toBe("dead");
      const delays = await page.evaluate(() => (window as any).__retryBudget.delays as number[]);
      writeFileSync(info.outputPath("retry-budget.json"), JSON.stringify({ delays, rejected: proxy.rejections() }));
      expect(await page.evaluate(() => (window as any).__retryBudget.opens)).toBe(9);
      expect(delays).toHaveLength(8); expect(proxy.rejections()).toBe(9);
      expect(Math.max(...delays)).toBeGreaterThan(delays[0]! * 2);
      proxy.cutBeforeViewport(false);
      await page.locator(".connection-status__retry:visible").click();
      await expect.poll(() => page.evaluate(n => window.__tmuxHubTerms?.[n]?.state, name)).toBe("connected");
      await expect.poll(() => page.evaluate(n => window.__tmuxHubTerms?.[n]?.replays ?? 0, name)).toBeGreaterThan(0);
      const before = await page.evaluate(n => window.__tmuxHubTerms![n]!.replays, name);
      await page.evaluate(n => window.__tmuxHubTerms![n]!.dropSocket(), name);
      await expect.poll(() => page.evaluate(n => window.__tmuxHubTerms![n]!.replays, name)).toBeGreaterThan(before);
      const last = await page.evaluate(() => (window as any).__retryBudget.delays.at(-1));
      expect(last).toBeLessThan(700); // A healthy authority reply resets to the first retry delay.
    } finally {
      try { writeFileSync(info.outputPath("retry-budget-final.json"), JSON.stringify({ budget: await page.evaluate(() => (window as any).__retryBudget), rejected: proxy.rejections() })); } catch {}
      await page.screenshot({ path: info.outputPath("retry-budget.png") }).catch(() => {}); await proxy.close(); }
  });
}
