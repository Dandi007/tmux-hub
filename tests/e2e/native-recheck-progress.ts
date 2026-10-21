import { test, expect } from "./emulator-fixtures";
import { bindSecret, waitForRegisteredSessions } from "./helpers";
import { gateNative } from "./native-owner-order";
import { stopNative } from "./native-viewport-fit";
import { holdWebSocketUpgrade } from "./renderer-proxy";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

export function defineNativeRecheckProgressTests() {
  for (const scenario of ["resize-before-reply", "hidden-reconnect-activation", "retry-after-error", "second-detach", "sse-snapshot"] as const) {
    test(`native detach completes current layout across ${scenario}`, async ({ page, ctx, baseURL }, info) => {
      const name = await ctx.createSession();
      const other = scenario === "hidden-reconnect-activation" ? await ctx.createSession() : null;
      if (other) {
        await (await page.context().newCDPSession(page)).send("Emulation.setTouchEmulationEnabled", { enabled: false });
        await page.setViewportSize({ width: 1400, height: 900 });
      }
      const tmux = (...args: string[]) => ctx.tmuxE2E(args);
      const attached = () => Number(tmux("display", "-p", "-t", name, "#{session_attached}"));
      const pane = () => tmux("display", "-p", "-t", name, "#{pane_width}x#{pane_height}");
      const read = () => page.evaluate(n => {
        const p = window.__tmuxHubTerms?.[n];
        return p ? { size: `${p.cols}x${p.rows}`, measured: p.measuredSize, screen: p.screen(), state: p.state, pending: p.replayPending, scroll: p.linesFromBottom, visible: p.visible } : null;
      }, name);
      const norm = (lines: string[]) => { const out = lines.map(s => s.trimEnd()); while (out.at(-1) === "") out.pop(); return out; };
      const inSync = async () => {
        const p = await read();
        return p?.state === "connected" && p.visible && !p.pending && p.scroll === 0 && p.size === p.measured && p.size === pane()
          && JSON.stringify(norm(p.screen)) === JSON.stringify(norm(tmux("capture-pane", "-p", "-t", name).split("\n")));
      };
      const proxy = await holdWebSocketUpgrade(Number(new URL(baseURL!).port)); proxy.release();
      tmux("set-hook", "-g", "client-attached", "resize-window -A");
      tmux("set-hook", "-g", "client-resized", "resize-window -A");
      const env = { ...process.env, TMUX_TMPDIR: ctx.tmuxTmpdir, TERM: "xterm-256color" }; delete env.TMUX;
      const launchNative = () => spawn("script", process.platform === "linux"
        ? ["-q", "-c", `tmux -L ${ctx.socket} attach -t ${name}`, "/dev/null"]
        : ["-q", "/dev/null", "tmux", "-L", ctx.socket, "attach", "-t", name], { env, stdio: ["pipe", "ignore", "ignore"] });
      const native = launchNative();
      let repeatNative: ReturnType<typeof spawn> | undefined;
      let launchError: Error | undefined; native.once("error", e => { launchError = e; });
      try {
        await expect.poll(() => { if (launchError) throw launchError; return attached(); }).toBeGreaterThan(0);
        await expect.poll(pane).toBe("80x23");
        tmux("send-keys", "-t", name, "printf '\\033[?1049h\\033[2J\\033[HNATIVE_PROGRESS\\033[2;80HX\\033[3;1HREADY_END\\n'", "Enter");
        await expect.poll(() => tmux("capture-pane", "-p", "-t", name).split("\n").some(s => s.trim() === "READY_END")).toBe(true);
        await gateNative(page, name, false, proxy.port);
        await page.goto("/system/health"); await bindSecret(page);
        await waitForRegisteredSessions(page, other ? [name, other] : [name]);
        await page.evaluate(n => localStorage.setItem("tmux-hub.last-session", n), name);
        await page.goto("/?debug=term");
        await expect.poll(async () => { const p = await read(); return p?.state === "connected" && p.visible && !p.pending && p.size === "80x23"; }).toBe(true);
        const before = await read(); expect(before!.measured).not.toBe(before!.size);
        if (other) await page.locator(`.tab-bar__tab[data-session="${other}"]`).click();
        else await page.evaluate(scenario => {
          const g = (window as any).__nativeOrder;
          if (scenario === "resize-before-reply") g.holdApplied = true;
          else if (scenario === "retry-after-error") g.failNextApplied = true;
          else if (scenario === "sse-snapshot") {
            g.holdSseRetry = true;
            const es = g.events.at(-1); es.close(); es.onerror(new Event("error"));
          }
        }, scenario);
        const zeros = await page.evaluate(scenario => {
          const g = (window as any).__nativeOrder;
          g.holdZeroAfter = g.zeros + (scenario === "second-detach" || scenario === "sse-snapshot" ? 0 : 1); return g.zeros;
        }, scenario);
        tmux("detach-client", "-s", name); await expect.poll(attached).toBe(0);
        if (scenario === "second-detach") {
          await expect.poll(() => page.evaluate(() => (window as any).__nativeOrder.heldActivity.length)).toBeGreaterThan(0);
          const positives = await page.evaluate(() => (window as any).__nativeOrder.positives);
          repeatNative = launchNative(); repeatNative.once("error", e => { launchError = e; });
          await expect.poll(attached).toBeGreaterThan(0);
          await expect.poll(() => page.evaluate(() => (window as any).__nativeOrder.positives)).toBeGreaterThan(positives);
          await page.evaluate(() => {
            const g = (window as any).__nativeOrder; g.armed = true;
            g.heldActivity.shift()();
          });
          await expect.poll(() => page.evaluate(() => (window as any).__nativeOrder.blocked)).toBe(true);
          await page.evaluate(() => { const g = (window as any).__nativeOrder; g.holdZeroAfter = g.zeros + 1; });
          tmux("detach-client", "-s", name); await expect.poll(attached).toBe(0);
          await expect.poll(() => page.evaluate(() => (window as any).__nativeOrder.zeros)).toBeGreaterThan(zeros);
          await page.evaluate(() => (window as any).__releaseNative());
        } else if (scenario === "sse-snapshot") {
          // Keep WS alive. Wait for the server registry to observe detach while
          // the app's SSE transport is actually closed and its retry is paused.
          await expect.poll(async () => {
            const response = await fetch(new URL("/events", baseURL)); const reader = response.body!.getReader();
            try {
              const chunk = await reader.read(), line = new TextDecoder().decode(chunk.value).split("\n").find(s => s.startsWith("data:"));
              const event = line ? JSON.parse(line.slice(5)) : null;
              return event?.payload?.find((s: any) => s.name === name)?.attached;
            } finally { await reader.cancel(); }
          }).toBe(0);
          const snapshots = await page.evaluate(() => (window as any).__nativeOrder.snapshots);
          await expect.poll(() => page.evaluate(() => (window as any).__nativeOrder.sseTimers.length)).toBe(1);
          await page.evaluate(() => {
            const g = (window as any).__nativeOrder; g.holdSseRetry = false;
            for (const run of g.sseTimers.splice(0)) run();
          });
          await expect.poll(() => page.evaluate(() => (window as any).__nativeOrder.snapshots)).toBeGreaterThan(snapshots);
          expect(await page.evaluate(() => (window as any).__nativeOrder.zeros)).toBe(zeros);
          expect(await page.evaluate(() => (window as any).__nativeOrder.sockets.length)).toBe(1);
        } else await expect.poll(() => page.evaluate(() => (window as any).__nativeOrder.zeros)).toBeGreaterThan(zeros);

        if (other) {
          proxy.hold(); await page.evaluate(n => window.__tmuxHubTerms![n]!.dropSocket(), name);
          await expect.poll(() => page.evaluate(() => (window as any).__nativeOrder.sockets.length)).toBe(2);
          await expect.poll(() => proxy.upgrades().some(u => u.accepted && u.pin === "0")).toBe(true);
          expect(await page.evaluate(() => (window as any).__nativeOrder.sockets.at(-1).readyState)).toBe(0);
          await page.locator(`.tab-bar__tab[data-session="${name}"]`).click();
          proxy.release();
        } else if (scenario === "resize-before-reply" || scenario === "retry-after-error") {
          await expect.poll(() => page.evaluate(scenario => {
            const g = (window as any).__nativeOrder;
            return scenario === "resize-before-reply" ? g.blocked : g.injectedErrors === 1;
          }, scenario)).toBe(true);
          await page.setViewportSize({ width: 1000, height: 700 });
          await expect.poll(async () => (await read())?.measured).not.toBe(before!.measured);
          if (scenario === "resize-before-reply") await page.evaluate(() => (window as any).__releaseNative());
          else await page.locator(".xterm-screen:visible").first().click({ position: { x: 20, y: 20 } });
        }
        await expect.poll(inSync, { message: "actual pane and browser must converge to current layout without extra SSE" }).toBe(true);
        writeFileSync(info.outputPath("native-progress.json"), JSON.stringify({ scenario, before, actual: await read(), pane: pane(), attached: attached(), injected: await page.evaluate(() => (window as any).__nativeOrder.injectedErrors) }, null, 2));
      } finally {
        try { writeFileSync(info.outputPath("native-progress-final.json"), JSON.stringify({ scenario, actual: await read(), pane: pane(), attached: attached() }, null, 2)); } catch {}
        await page.screenshot({ path: info.outputPath("native-progress.png") }).catch(() => {});
        try { await proxy.close(); }
        finally { try { if (attached() > 0) tmux("detach-client", "-s", name); } finally { try { await stopNative(native); } finally { if (repeatNative) await stopNative(repeatNative); } } }
      }
    });
  }
}
