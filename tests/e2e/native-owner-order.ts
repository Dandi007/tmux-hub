import { test, expect } from "./emulator-fixtures";
import { bindSecret, waitForRegisteredSessions } from "./helpers";
import { stopNative } from "./native-viewport-fit";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";

// Delay a real ordered WS stream, never individual metadata ahead of later
// bytes on that socket. SSE remains independently delivered.
async function gateNative(page: Page, name: string, armed: boolean) {
  await page.addInitScript(({ n, armed }) => {
    const g = (window as any).__nativeOrder = { armed, blocked: false, held: [] as (() => void)[], messages: [] as unknown[], zeros: 0, positives: 0 };
    const W = window.WebSocket;
    window.WebSocket = class extends W {
      set onmessage(handler) {
        super.onmessage = handler ? function(event) {
          if (decodeURIComponent(new URL(this.url).pathname.split("/").at(-1)!) !== n) { handler.call(this, event); return; }
          if (typeof event.data === "string") {
            try {
              const m = JSON.parse(event.data);
              if (m.kind === "viewport") {
                g.messages.push(m);
                if (g.armed && m.owner === "native") g.blocked = true;
              }
            } catch {}
          }
          if (g.blocked) g.held.push(() => handler.call(this, event));
          else handler.call(this, event);
        } : null;
      }
    };
    const E = window.EventSource;
    window.EventSource = class extends E {
      set onmessage(handler) {
        super.onmessage = handler ? function(event) {
          handler.call(this, event);
          const m = JSON.parse(event.data);
          if (m.event === "session_activity" && m.payload.name === n) {
            if (m.payload.attached === 0) g.zeros++; else g.positives++;
          }
        } : null;
      }
    };
    (window as any).__releaseNative = () => {
      g.armed = false; g.blocked = false;
      for (const deliver of g.held.splice(0)) deliver();
    };
  }, { n: name, armed });
}

export function defineNativeOwnerOrderTests() {
  for (const scenario of ["detach-first", "web-pinner-release", "hidden-detach"] as const) {
    test(`native ownership remains authoritative across ${scenario}`, async ({ page, ctx }, info) => {
      const name = await ctx.createSession();
      const other = scenario === "hidden-detach" ? await ctx.createSession() : null;
      if (other) await page.setViewportSize({ width: 1400, height: 900 });
      const tmux = (...args: string[]) => ctx.tmuxE2E(args);
      const attached = () => Number(tmux("display", "-p", "-t", name, "#{session_attached}"));
      const paneSize = () => tmux("display", "-p", "-t", name, "#{pane_width}x#{pane_height}");
      const normalize = (lines: string[]) => { const out = lines.map(s => s.trimEnd()); while (out.at(-1) === "") out.pop(); return out; };
      const read = () => page.evaluate(n => {
        const p = window.__tmuxHubTerms?.[n];
        return p ? { size: `${p.cols}x${p.rows}`, measured: p.measuredSize, screen: p.screen(), state: p.state, pending: p.replayPending, scroll: p.linesFromBottom, visible: p.visible } : null;
      }, name);
      const inSync = async () => {
        const p = await read();
        return p?.state === "connected" && p.visible && !p.pending && p.scroll === 0 && p.size === paneSize()
          && JSON.stringify(normalize(p.screen)) === JSON.stringify(normalize(tmux("capture-pane", "-p", "-t", name).split("\n")));
      };
      const open = async (p: Page, waitForReplay = true) => {
        // Bootstrap auth on a non-app document: one application navigation.
        await p.goto("/system/health"); await bindSecret(p);
        await waitForRegisteredSessions(p, other ? [name, other] : [name]);
        await p.evaluate(n => localStorage.setItem("tmux-hub.last-session", n), name);
        await p.goto("/?debug=term");
        await expect.poll(() => p.evaluate(n => {
          if (!window.__tmuxHubTerms?.[n]?.visible) window.__tmuxHub?.openSession?.(n);
          return window.__tmuxHubTerms?.[n]?.visible ?? false;
        }, name)).toBe(true);
        if (waitForReplay) await expect.poll(() => p.evaluate(n => window.__tmuxHubTerms?.[n]?.replays ?? 0, name)).toBeGreaterThan(0);
      };
      let peer: Page | undefined;
      const env = { ...process.env, TMUX_TMPDIR: ctx.tmuxTmpdir, TERM: "xterm-256color" }; delete env.TMUX;
      let native: ReturnType<typeof spawn> | undefined;
      let launchError: Error | undefined;
      try {
        if (scenario === "web-pinner-release") {
          peer = await page.context().newPage(); await open(peer);
          await expect.poll(() => paneSize()).not.toBe("80x24");
        }
        // Reproduce the production native hooks on this isolated server. Its
        // first hub startup may have preceded any tmux server/session.
        tmux("set-hook", "-g", "client-attached", "resize-window -A");
        tmux("set-hook", "-g", "client-resized", "resize-window -A");
        native = spawn("script", process.platform === "linux"
          ? ["-q", "-c", `tmux -L ${ctx.socket} attach -t ${name}`, "/dev/null"]
          : ["-q", "/dev/null", "tmux", "-L", ctx.socket, "attach", "-t", name], { env, stdio: ["pipe", "ignore", "ignore"] });
        native.once("error", error => { launchError = error; });
        await expect.poll(() => { if (launchError) throw launchError; return attached(); }).toBeGreaterThan(0);
        await expect.poll(paneSize).toBe("80x23");
        const nativeSize = paneSize();
        tmux("send-keys", "-t", name, "printf '\\033[?1049h\\033[2J\\033[HNATIVE_ORDER\\033[2;80HX\\033[3;1HNATIVE_END\\n'", "Enter");
        await expect.poll(() => tmux("capture-pane", "-p", "-t", name).split("\n").some(s => s.trim() === "NATIVE_END")).toBe(true);
        await gateNative(page, name, scenario !== "web-pinner-release");
        await open(page, scenario === "web-pinner-release");
        if (scenario === "web-pinner-release") await expect.poll(inSync).toBe(true);
        await page.evaluate(() => { (window as any).__nativeOrder.armed = true; });
        if (scenario !== "web-pinner-release") {
          // The initial native metadata and all following WS bytes are held.
          // Actual detach SSE arrives before that real initial ownership reply.
          await expect.poll(() => page.evaluate(() => (window as any).__nativeOrder.blocked)).toBe(true);
          if (other) {
            await page.locator(`.tab-bar__tab[data-session="${other}"]`).click();
            expect((await read())?.visible).toBe(false);
          }
          const zeros = await page.evaluate(() => (window as any).__nativeOrder.zeros);
          tmux("detach-client", "-s", name); await expect.poll(attached).toBe(0);
          await expect.poll(() => page.evaluate(() => (window as any).__nativeOrder.zeros)).toBeGreaterThan(zeros);
          await page.evaluate(() => (window as any).__releaseNative());
          if (other) {
            expect(paneSize()).toBe(nativeSize);
            await page.locator(`.tab-bar__tab[data-session="${name}"]`).click();
          }
          await expect.poll(async () => (await read())?.size).toBe((await read())!.measured);
          await expect.poll(inSync).toBe(true);
        } else {
          await peer!.close(); peer = undefined;
          await expect.poll(() => page.evaluate(() => (window as any).__nativeOrder.messages.some((m: any) => m.released))).toBe(true);
          // Reading after the real release callback observes its synchronous fit.
          const actual = await read();
          expect(actual!.measured).not.toBe(nativeSize);
          writeFileSync(info.outputPath("release-observation.json"), JSON.stringify({ actual, nativeSize, pane: paneSize() }));
          expect(actual!.size).toBe(nativeSize); expect(attached()).toBeGreaterThan(0);
          await expect.poll(inSync).toBe(true);
          await page.evaluate(() => (window as any).__releaseNative());
          tmux("detach-client", "-s", name); await expect.poll(attached).toBe(0);
          await expect.poll(async () => (await read())?.size).toBe((await read())!.measured);
          await expect.poll(inSync).toBe(true);
        }
        writeFileSync(info.outputPath("native-owner-order.json"), JSON.stringify({ scenario, nativeSize, actual: await read(), pane: paneSize(), attached: attached(), events: await page.evaluate(() => { const g = (window as any).__nativeOrder; return { messages: g.messages, zeros: g.zeros, positives: g.positives }; }) }, null, 2));
        await page.screenshot({ path: info.outputPath("native-owner-order.png") });
      } finally {
        await page.screenshot({ path: info.outputPath("native-owner-final.png") }).catch(() => {});
        try { await peer?.close(); }
        finally {
          try { if (attached() > 0) tmux("detach-client", "-s", name); }
          finally { if (native) await stopNative(native); }
        }
      }
    });
  }
}
