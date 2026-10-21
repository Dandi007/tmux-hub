import { test, expect } from "./emulator-fixtures";
import { bindSecret, waitForRegisteredSessions } from "./helpers";
import { gateNative } from "./native-owner-order";
import { stopNative } from "./native-viewport-fit";
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

export function defineNativeProbeRoundtripTests() {
  test("native TTY size round-trip preserves newer hint ahead of an old probe reply", async ({ page, ctx }, info) => {
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
    try {
      await expect.poll(() => { if (error) throw error; return attached(); }).toBe(1); await expect.poll(pane).toBe("80x23"); await expect.poll(synced).toBe(true);
      const clients = tmux("list-clients", "-t", name, "-F", "#{client_tty}|#{client_pid}").split("\n"); expect(clients).toHaveLength(1);
      const [tty, pid] = clients[0]!.split("|");
      const resize = (cols: number, rows: number) => {
        expect(spawnSync("stty", [process.platform === "linux" ? "-F" : "-f", tty!, "cols", String(cols), "rows", String(rows)]).status).toBe(0);
        expect(spawnSync("kill", ["-WINCH", pid!]).status).toBe(0);
      };
      await page.evaluate(() => { (window as any).__nativeOrder.armed = true; });
      resize(100, 32); await expect.poll(pane).toBe("100x31");
      await expect.poll(() => page.evaluate(() => { const g = (window as any).__nativeOrder; return g.blocked && g.messages.some((m: any) => m.owner === "native" && m.cols === 100 && m.rows === 31); })).toBe(true);
      const positives = await page.evaluate(() => (window as any).__nativeOrder.positives);
      resize(80, 24); await expect.poll(pane).toBe("80x23");
      await expect.poll(() => page.evaluate(() => (window as any).__nativeOrder.positives)).toBeGreaterThan(positives);
      expect((await read())!.size).toBe("80x23"); // The100 reply is still held, in order.
      tmux("send-keys", "-t", name, "printf '\\033[2J\\033[H'; printf '%79sX\\nROUNDTRIP_END\\n' ''", "Enter");
      await expect.poll(() => tmux("capture-pane", "-p", "-t", name).split("\n").some(s => s.trim() === "ROUNDTRIP_END")).toBe(true);
      await page.evaluate(() => (window as any).__releaseNative());
      await expect.poll(synced).toBe(true);
      expect(await page.evaluate(() => (window as any).__nativeOrder.sockets.length)).toBe(1);
    } finally {
      try { writeFileSync(info.outputPath("native-roundtrip.json"), JSON.stringify({ actual: await read(), pane: pane(), events: await page.evaluate(() => { const g = (window as any).__nativeOrder; return { messages: g.messages, checks: g.checks, positives: g.positives, sockets: g.sockets.length }; }) }, null, 2)); } catch {}
      await page.screenshot({ path: info.outputPath("native-roundtrip.png") }).catch(() => {});
      try { if (attached() > 0) tmux("detach-client", "-s", name); } finally { await stopNative(native); }
    }
  });
}
