import { test, expect } from "./emulator-fixtures";
import { bindSecret, waitForRegisteredSessions } from "./helpers";
import { captureForegroundScreenshot, withForegroundContext } from "./foreground-browser";
import { stopNative } from "./native-viewport-fit";
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

export function defineNativeLateAttachTests() {
  for (const mobile of [false, true]) {
    test(`web first ${mobile ? "phone" : "desktop"} adopts later native attach and real TTY resize`, async ({ ctx, baseURL }, info) => {
      test.setTimeout(60_000);
      const name = await ctx.createSession(), observations: unknown[] = [];
      const tmux = (...args: string[]) => ctx.tmuxE2E(args);
      const size = () => tmux("display", "-p", "-t", name, "#{pane_width}x#{pane_height}");
      const attached = () => Number(tmux("display", "-p", "-t", name, "#{session_attached}"));
      const normalized = (ls: string[]) => { const out = ls.map(s => s.trimEnd()); while (out.at(-1) === "") out.pop(); return out; };
      let native: ReturnType<typeof spawn> | undefined;
      try {
        // Production hooks, confined to the fixture's private tmux server.
        tmux("set-hook", "-g", "client-attached", "resize-window -A");
        tmux("set-hook", "-g", "client-resized", "resize-window -A");
        await withForegroundContext(info.outputPath("native-late-browser.log"), async context => {
          const page = await context.newPage(), cdp = await context.newCDPSession(page);
          await cdp.send("Emulation.setDeviceMetricsOverride", { width: mobile ? 430 : 1400, height: 900, deviceScaleFactor: 1, mobile });
          await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
          if (mobile) await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
          await page.goto(new URL("/system/health", baseURL).href); await bindSecret(page);
          await waitForRegisteredSessions(page, [name]);
          await page.evaluate(n => localStorage.setItem("tmux-hub.last-session", n), name);
          await page.goto(new URL("/?debug=term", baseURL).href); await page.bringToFront();
          const read = () => page.evaluate(n => {
            const p = window.__tmuxHubTerms?.[n];
            return p ? { size: `${p.cols}x${p.rows}`, measured: p.measuredSize, screen: p.screen(), state: p.state, pending: p.replayPending, scroll: p.linesFromBottom, visible: p.visible, replays: p.replays } : null;
          }, name);
          const inSync = async () => {
            const p = await read();
            return p?.state === "connected" && p.visible && !p.pending && p.scroll === 0 && p.size === size()
              && JSON.stringify(normalized(p.screen)) === JSON.stringify(normalized(tmux("capture-pane", "-p", "-t", name).split("\n")));
          };
          const snapshot = async (phase: string) => {
            observations.push({ phase, actual: await read(), pane: size(), attached: attached(), expected: tmux("capture-pane", "-p", "-t", name).split("\n") });
            writeFileSync(info.outputPath("native-late.json"), JSON.stringify(observations, null, 2));
            await captureForegroundScreenshot(cdp, info.outputPath(`native-late-${phase}.png`));
          };
          await expect.poll(inSync).toBe(true); await snapshot("web-first"); expect(attached()).toBe(0);
          const env = { ...process.env, TMUX_TMPDIR: ctx.tmuxTmpdir, TERM: "xterm-256color" }; delete env.TMUX;
          native = spawn("script", process.platform === "linux"
            ? ["-q", "-c", `tmux -L ${ctx.socket} attach -t ${name}`, "/dev/null"]
            : ["-q", "/dev/null", "tmux", "-L", ctx.socket, "attach", "-t", name], { env, stdio: ["pipe", "ignore", "ignore"] });
          let launchError: Error | undefined; native.once("error", e => { launchError = e; });
          await expect.poll(() => { if (launchError) throw launchError; return attached(); }).toBe(1);
          await expect.poll(size).toBe("80x23");
          tmux("send-keys", "-t", name, "printf '\\033[2J\\033[H'; printf '%79sX\\nLATE_ATTACH_END\\n' ''", "Enter");
          await expect.poll(() => tmux("capture-pane", "-p", "-t", name).split("\n").some(s => s.trim() === "LATE_ATTACH_END")).toBe(true);
          await expect.configure({ soft: true }).poll(inSync, { message: "existing page adopts actual native attach grid and screen without interaction" }).toBe(true);
          await snapshot("attached");
          const clients = tmux("list-clients", "-t", name, "-F", "#{client_tty}|#{client_pid}").split("\n"); expect(clients).toHaveLength(1);
          const [tty, pid] = clients[0]!.split("|");
          expect(spawnSync("stty", [process.platform === "linux" ? "-F" : "-f", tty!, "cols", "100", "rows", "32"]).status).toBe(0);
          expect(spawnSync("kill", ["-WINCH", pid!]).status).toBe(0);
          await expect.poll(size).toBe("100x31");
          tmux("send-keys", "-t", name, "printf '\\033[2J\\033[H'; printf '%99sX\\nLATE_RESIZE_END\\n' ''", "Enter");
          await expect.poll(() => tmux("capture-pane", "-p", "-t", name).split("\n").some(s => s.trim() === "LATE_RESIZE_END")).toBe(true);
          await expect.configure({ soft: true }).poll(inSync, { message: "same page adopts real TTY resize and aligned screen without reconnect" }).toBe(true);
          await snapshot("resized");
          tmux("detach-client", "-s", name); await expect.poll(attached).toBe(0);
          await expect.poll(async () => size() === (await read())?.measured).toBe(true);
          await expect.poll(inSync).toBe(true); await snapshot("detached");
          await page.close();
        });
      } finally {
        try { if (attached() > 0) tmux("detach-client", "-s", name); }
        finally { if (native) await stopNative(native); }
      }
    });
  }
}
