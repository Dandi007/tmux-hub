import { test, expect } from "./emulator-fixtures";
import { bindSecret, waitForRegisteredSessions } from "./helpers";
import { gateNative } from "./native-owner-order";
import { stopNative } from "./native-viewport-fit";
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

export function defineNativeProbeRoundtripTests() {
  for (const scenario of ["own-probe", "peer-broadcast", "peer-snapshot-first"] as const) test(`native TTY size round-trip preserves newer hint ahead of an old ${scenario} reply`, async ({ page, ctx }, info) => {
    const name = await ctx.createSession(), tmux = (...args: string[]) => ctx.tmuxE2E(args);
    const pane = () => tmux("display", "-p", "-t", name, "#{pane_width}x#{pane_height}");
    const attached = () => Number(tmux("display", "-p", "-t", name, "#{session_attached}"));
    const norm = (ls: string[]) => { const out = ls.map(s => s.trimEnd()); while (out.at(-1) === "") out.pop(); return out; };
    const read = () => page.evaluate(n => { const p = window.__tmuxHubTerms?.[n]; return p ? { size: `${p.cols}x${p.rows}`, state: p.state, pending: p.replayPending, scroll: p.linesFromBottom, screen: p.screen() } : null; }, name);
    const synced = async () => { const p = await read(); return p?.state === "connected" && !p.pending && p.scroll === 0 && p.size === pane()
      && JSON.stringify(norm(p.screen)) === JSON.stringify(norm(tmux("capture-pane", "-p", "-t", name).split("\n"))); };
    await gateNative(page, name, false);
    await page.goto("/system/health"); await bindSecret(page); await waitForRegisteredSessions(page, [name]);
    await page.evaluate(n => localStorage.setItem("tmux-hub.last-session", n), name); await page.goto("/?debug=term");
    await expect.poll(synced).toBe(true);
    tmux("set-hook", "-g", "client-attached", "resize-window -A"); tmux("set-hook", "-g", "client-resized", "resize-window -A");
    const env = { ...process.env, TMUX_TMPDIR: ctx.tmuxTmpdir, TERM: "xterm-256color" }; delete env.TMUX;
    const native = spawn("script", process.platform === "linux" ? ["-q", "-c", `tmux -L ${ctx.socket} attach -t ${name}`, "/dev/null"] : ["-q", "/dev/null", "tmux", "-L", ctx.socket, "attach", "-t", name], { env, stdio: ["pipe", "ignore", "ignore"] });
    let error: Error | undefined; native.once("error", e => { error = e; });
    let peer: import("@playwright/test").Page | undefined;
    let primaryFailure: { error: unknown } | undefined;
    try {
      await expect.poll(() => { if (error) throw error; return attached(); }).toBe(1); await expect.poll(pane).toBe("80x23"); await expect.poll(synced).toBe(true);
      const clients = tmux("list-clients", "-t", name, "-F", "#{client_tty}|#{client_pid}").split("\n"); expect(clients).toHaveLength(1);
      const [tty, pid] = clients[0]!.split("|");
      const resize = (cols: number, rows: number) => {
        expect(spawnSync("stty", [process.platform === "linux" ? "-F" : "-f", tty!, "cols", String(cols), "rows", String(rows)]).status).toBe(0);
        expect(spawnSync("kill", ["-WINCH", pid!]).status).toBe(0);
      };
      await expect.poll(() => page.evaluate(() => (window as any).__nativeOrder.activity
        .some((s: any) => s.attached > 0 && s.cols === 80 && s.rows === 23))).toBe(true);
      tmux("send-keys", "-t", name, "printf '\\033[2J\\033[H'; printf '%79sX\\nROUNDTRIP_END\\n' ''", "Enter");
      await expect.poll(() => tmux("capture-pane", "-p", "-t", name).split("\n").some(s => s.trim() === "ROUNDTRIP_END")).toBe(true);
      await expect.poll(synced).toBe(true);
      await page.evaluate(() => { (window as any).__nativeOrder.armed = true; });
      if (scenario !== "own-probe") {
        // Interrupt this page's actual SSE connection. Hold its reconnect,
        // so only the peer observes the intermediate native size.
        await page.evaluate(() => {
          const g = (window as any).__nativeOrder; g.holdSseRetry = true;
          g.events.at(-1).dispatchEvent(new Event("error"));
        });
        await expect.poll(() => page.evaluate(() => (window as any).__nativeOrder.sseTimers.length)).toBe(1);
      }
      resize(100, 32); await expect.poll(pane).toBe("100x31");
      if (scenario !== "own-probe") {
        peer = await page.context().newPage();
        await peer.goto("/system/health"); await bindSecret(peer);
        await peer.evaluate(n => localStorage.setItem("tmux-hub.last-session", n), name);
        await peer.goto("/?debug=term");
        await expect.poll(() => peer!.evaluate(n => { const p = window.__tmuxHubTerms?.[n]; return p ? `${p.cols}x${p.rows}` : ""; }, name)).toBe("100x31");
      }
      await expect.poll(() => page.evaluate(() => { const g = (window as any).__nativeOrder; return g.blocked && g.messages.some((m: any) => m.owner === "native" && m.cols === 100 && m.rows === 31); })).toBe(true);
      await peer?.close(); peer = undefined;
      const activity = await page.evaluate(() => (window as any).__nativeOrder.activity.length);
      resize(80, 24); await expect.poll(pane).toBe("80x23");
      if (scenario !== "own-probe") {
        // Deliver the old broadcast with no local probe in flight, then
        // restore real SSE and wait for its fresh 80x23 snapshot callback.
        if (scenario === "peer-broadcast") {
          await page.evaluate(() => (window as any).__releaseNative());
          await expect.poll(async () => (await read())?.size).toBe("100x31");
        }
        await page.evaluate(() => {
          const g = (window as any).__nativeOrder; g.holdSseRetry = false;
          for (const reconnect of g.sseTimers.splice(0)) reconnect();
        });
      }
      await expect.poll(() => page.evaluate(start => (window as any).__nativeOrder.activity.slice(start)
        .some((s: any) => s.attached > 0 && s.cols === 80 && s.rows === 23), activity)).toBe(true);
      if (scenario !== "peer-broadcast") expect((await read())!.size).toBe("80x23"); // The 100 reply remains held, in order.
      // No later activity may rescue a lost critical demand. Pause the real
      // SSE transport after its precise callback, retaining the same live WS.
      await page.evaluate(() => {
        const g = (window as any).__nativeOrder; g.holdSseRetry = true;
        const es = g.events.at(-1); es.close(); es.onerror(new Event("error"));
      });
      await page.evaluate(() => (window as any).__releaseNative());
      await expect.poll(synced).toBe(true);
      expect(attached()).toBe(1); expect(pane()).toBe("80x23"); expect((await read())!.size).toBe("80x23");
      const converged = await read();
      writeFileSync(info.outputPath("native-critical-convergence.json"), JSON.stringify({ actual: converged, pane: pane(), events: await page.evaluate(() => { const g = (window as any).__nativeOrder; return { activity: g.activity, probes: g.probes, checks: g.checks, sockets: g.sockets.length }; }) }));
      // Resume actual SSE before checking quiescence: a feedback loop must
      // remain observable, rather than being silenced by the fault fixture.
      await expect.poll(() => page.evaluate(() => (window as any).__nativeOrder.sseTimers.length)).toBe(1);
      const snapshots = await page.evaluate(() => (window as any).__nativeOrder.snapshots);
      await page.evaluate(() => {
        const g = (window as any).__nativeOrder; g.holdSseRetry = false;
        for (const reconnect of g.sseTimers.splice(0)) reconnect();
      });
      await expect.poll(() => page.evaluate(() => (window as any).__nativeOrder.snapshots)).toBeGreaterThan(snapshots);
      await expect.poll(synced).toBe(true);
      expect(await page.evaluate(() => (window as any).__nativeOrder.sockets.length)).toBe(1);
      // Observe more than two real registry polling periods after output stops.
      // A query -> SSE -> query feedback loop cannot satisfy this quiet window.
      const quietSamples: unknown[] = [];
      let prior = "", unchangedSince = Date.now();
      await expect.poll(async () => {
        const counts = await page.evaluate(() => {
          const g = (window as any).__nativeOrder;
          return { activity: g.activity.length, probes: g.probes.length, checks: g.checks.length };
        });
        quietSamples.push({ at: Date.now(), ...counts });
        const current = JSON.stringify(counts);
        if (current !== prior) { prior = current; unchangedSince = Date.now(); }
        return Date.now() - unchangedSince >= 4500;
      }, { timeout: 12_000, intervals: [250] }).toBe(true);
      writeFileSync(info.outputPath("native-query-quiet.json"), JSON.stringify(quietSamples));
      expect(attached()).toBe(1); expect(pane()).toBe("80x23"); expect((await read())!.size).toBe("80x23");
      expect(await synced()).toBe(true);
      expect(await page.evaluate(() => (window as any).__nativeOrder.sockets.length)).toBe(1);
    } catch (error) {
      primaryFailure = { error }; throw error;
    } finally {
      try { writeFileSync(info.outputPath("native-roundtrip.json"), JSON.stringify({ actual: await read(), pane: pane(), events: await page.evaluate(() => { const g = (window as any).__nativeOrder; return { messages: g.messages, checks: g.checks, positives: g.positives, activity: g.activity, probes: g.probes, sockets: g.sockets.length }; }) }, null, 2)); } catch {}
      await page.screenshot({ path: info.outputPath("native-roundtrip.png") }).catch(() => {});
      const cleanupErrors: unknown[] = [];
      const clean = async (task: () => unknown) => { try { await task(); } catch (error) { cleanupErrors.push(error); } };
      await clean(() => peer?.close());
      await clean(() => { if (attached() > 0) tmux("detach-client", "-s", name); });
      await clean(() => stopNative(native));
      try { writeFileSync(info.outputPath("native-cleanup.json"), JSON.stringify({ errors: cleanupErrors.map(String), primaryFailure: primaryFailure ? String(primaryFailure.error) : null, nativeExitCode: native.exitCode, nativeSignal: native.signalCode })); } catch {}
      if (!primaryFailure && cleanupErrors.length) throw new AggregateError(cleanupErrors, "native fixture cleanup failed");
    }
  });
}
