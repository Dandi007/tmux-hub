import { test, expect } from "./emulator-fixtures";
import { bindSecret, waitForRegisteredSessions } from "./helpers";
import { gateNative } from "./native-owner-order";
import { stopNative } from "./native-viewport-fit";
import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

export function defineNativeProbeProgressTests() {
  for (const scenario of ["peer-before-init", "query-failure"] as const) {
    test(`native read-only probe survives ${scenario} without interaction`, async ({ page, ctx }, info) => {
      test.setTimeout(60_000);
      const name = await ctx.createSession(), other = scenario === "peer-before-init" ? await ctx.createSession() : null;
      const tmux = (...args: string[]) => ctx.tmuxE2E(args);
      const attached = () => Number(tmux("display", "-p", "-t", name, "#{session_attached}"));
      const size = () => tmux("display", "-p", "-t", name, "#{pane_width}x#{pane_height}");
      const norm = (ls: string[]) => { const out = ls.map(s => s.trimEnd()); while (out.at(-1) === "") out.pop(); return out; };
      const read = () => page.evaluate(n => {
        const p = window.__tmuxHubTerms?.[n];
        return p ? { size: `${p.cols}x${p.rows}`, screen: p.screen(), pending: p.replayPending, scroll: p.linesFromBottom, state: p.state, visible: p.visible } : null;
      }, name);
      const inSync = async () => {
        const p = await read(); return p?.state === "connected" && p.visible && !p.pending && p.scroll === 0 && p.size === size()
          && JSON.stringify(norm(p.screen)) === JSON.stringify(norm(tmux("capture-pane", "-p", "-t", name).split("\n")));
      };
      const open = async (p: Page) => {
        await p.goto("/system/health"); await bindSecret(p); await waitForRegisteredSessions(p, other ? [name, other] : [name]);
        await p.evaluate(n => localStorage.setItem("tmux-hub.last-session", n), name); await p.goto("/?debug=term");
      };
      let peer: Page | undefined, native: ReturnType<typeof spawn> | undefined;
      const socketPath = join(ctx.tmuxTmpdir, `tmux-${process.getuid!()}`, ctx.socket), paused = socketPath + ".probe-paused";
      let socketPaused = false;
      try {
        await gateNative(page, name, false);
        if (other) {
          // This exercises the desktop pool even under the Pixel project.
          await (await page.context().newCDPSession(page)).send("Emulation.setTouchEmulationEnabled", { enabled: false });
          await page.setViewportSize({ width: 1400, height: 900 });
          await page.addInitScript(() => {
            (window as any).__nativeOrder.blocked = true;
            const schedule = window.setTimeout;
            (window as any).__heldRenderer = 0;
            window.setTimeout = ((fn: TimerHandler, delay?: number, ...args: unknown[]) => {
              const text = typeof fn === "function" ? String(fn) : "";
              if ((delay === 50 && text.includes("CanvasAddon")) || (delay === 100 && text.includes("readyState"))) {
                (window as any).__heldRenderer++; return schedule(() => {}, 60_000);
              }
              return schedule(fn, delay, ...args);
            }) as typeof window.setTimeout;
          });
          peer = await page.context().newPage(); await peer.setViewportSize({ width: 1400, height: 900 });
          await (await peer.context().newCDPSession(peer)).send("Emulation.setTouchEmulationEnabled", { enabled: false });
          await gateNative(peer, name, false); await open(peer);
          await expect.poll(() => peer!.evaluate(n => window.__tmuxHubTerms?.[n]?.replayPending, name)).toBe(false);
          // Queue real serialized tmux mutations before A registers. The tail
          // publishes real peer notices to A before A's own initial authority.
          await peer.evaluate(() => {
            const ws = (window as any).__nativeOrder.sockets.at(-1);
            for (let i = 0; i < 80; i++) ws.send(JSON.stringify({ kind: "resize", cols: 120 + i % 2, rows: 30 }));
          });
          await open(page);
          await expect.poll(() => page.evaluate(() => (window as any).__nativeOrder.messages.some((m: any) => m.applied))).toBe(true);
          const messages = await page.evaluate(() => (window as any).__nativeOrder.messages);
          expect(messages[0].peer).toBe(true); // A real ordering barrier, not reordered callbacks.
          await peer.locator(`.tab-bar__tab[data-session="${other}"]`).click();
          expect(await peer.evaluate(n => window.__tmuxHubTerms?.[n]?.visible, name)).toBe(false);
        } else {
          await open(page); await expect.poll(inSync).toBe(true);
          await page.evaluate(() => { (window as any).__nativeOrder.holdPositive = true; });
        }
        tmux("set-hook", "-g", "client-attached", "resize-window -A");
        tmux("set-hook", "-g", "client-resized", "resize-window -A");
        const env = { ...process.env, TMUX_TMPDIR: ctx.tmuxTmpdir, TERM: "xterm-256color" }; delete env.TMUX;
        native = spawn("script", process.platform === "linux" ? ["-q", "-c", `tmux -L ${ctx.socket} attach -t ${name}`, "/dev/null"] : ["-q", "/dev/null", "tmux", "-L", ctx.socket, "attach", "-t", name], { env, stdio: ["pipe", "ignore", "ignore"] });
        let launchError: Error | undefined; native.once("error", e => { launchError = e; });
        await expect.poll(() => { if (launchError) throw launchError; return attached(); }).toBe(1);
        await expect.poll(size).toBe("80x23");
        if (other) {
          await expect.poll(() => page.evaluate(() => (window as any).__nativeOrder.positives)).toBeGreaterThan(0);
          await page.evaluate(() => (window as any).__releaseNative());
        } else {
          await expect.poll(() => page.evaluate(() => (window as any).__nativeOrder.positiveHeld.length)).toBeGreaterThan(0);
          // Temporarily move ONLY this fixture's Unix socket. Existing native
          // TTY/WS stay connected, real new tmux queries fail until restored.
          expect(ctx.socket).toMatch(/^hub-e2e-/);
          renameSync(socketPath, paused); socketPaused = true;
          await page.evaluate(() => {
            const g = (window as any).__nativeOrder; g.holdPositive = false;
            for (const deliver of g.positiveHeld.splice(0)) deliver();
          });
          await expect.poll(() => page.evaluate(() => (window as any).__nativeOrder.checks.some((m: any) => !m.ok))).toBe(true);
          await page.evaluate(() => { for (const es of (window as any).__nativeOrder.events) es.close(); });
          renameSync(paused, socketPath); socketPaused = false;
        }
        tmux("send-keys", "-t", name, "printf '\\033[2J\\033[H'; printf '%79sX\\nPROBE_PROGRESS_END\\n' ''", "Enter");
        await expect.poll(() => tmux("capture-pane", "-p", "-t", name).split("\n").some(s => s.trim() === "PROBE_PROGRESS_END")).toBe(true);
        await expect.poll(inSync).toBe(true);
        expect(await page.evaluate(() => (window as any).__nativeOrder.sockets.length)).toBe(1);
      } finally {
        if (socketPaused) { renameSync(paused, socketPath); socketPaused = false; }
        try { writeFileSync(info.outputPath("native-probe-progress.json"), JSON.stringify({ scenario, actual: await read(), pane: size(), events: await page.evaluate(() => { const g = (window as any).__nativeOrder; return { messages: g.messages, checks: g.checks, positives: g.positives, sockets: g.sockets.length }; }) }, null, 2)); } catch {}
        await page.screenshot({ path: info.outputPath("native-probe-progress.png") }).catch(() => {});
        try { await peer?.close(); } finally { try { if (attached() > 0) tmux("detach-client", "-s", name); } finally { if (native) await stopNative(native); } }
      }
    });
  }
}
