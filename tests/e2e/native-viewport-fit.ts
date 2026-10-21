import { test, expect } from "./emulator-fixtures";
import { bindSecret } from "./helpers";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const normalized = (lines: string[]) => {
  const result = lines.map(line => line.trimEnd());
  while (result.at(-1) === "") result.pop();
  return result;
};

export function defineNativeViewportFitTests() {
  for (const mobile of [false, true]) {
    test(`native online ${mobile ? "phone" : "desktop"} keeps its pane grid through layout and interaction`, async ({ browser, baseURL, ctx }, info) => {
      const name = await ctx.createSession();
      const other = mobile ? null : await ctx.createSession();
      const tmux = (...args: string[]) => ctx.tmuxE2E(args);
      const paneSize = () => tmux("display", "-p", "-t", name, "#{pane_width}x#{pane_height}");
      const attached = () => Number(tmux("display", "-p", "-t", name, "#{session_attached}"));
      const env = { ...process.env, TMUX_TMPDIR: ctx.tmuxTmpdir, TERM: "xterm-256color" }; delete env.TMUX;
      const args = process.platform === "linux"
        ? ["-q", "-c", `tmux -L ${ctx.socket} attach -t ${name}`, "/dev/null"]
        : ["-q", "/dev/null", "tmux", "-L", ctx.socket, "attach", "-t", name];
      const native = spawn("script", args, { env, stdio: ["pipe", "ignore", "ignore"] });
      const context = await browser.newContext({ baseURL, viewport: mobile ? { width: 430, height: 900 } : { width: 1400, height: 900 }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
      const page = await context.newPage();
      const observations: unknown[] = [];
      const read = () => page.evaluate(n => {
        const p = window.__tmuxHubTerms?.[n];
        return p ? { size: `${p.cols}x${p.rows}`, measured: p.measuredSize, screen: p.screen(), state: p.state, visible: p.visible, replays: p.replays, pending: p.replayPending } : null;
      }, name);
      const snapshot = async (phase: string) => {
        const value = { phase, browser: await read(), pane: { size: paneSize(), screen: tmux("capture-pane", "-p", "-t", name).split("\n") }, attached: attached() };
        observations.push(value);
        writeFileSync(info.outputPath("native-online.json"), JSON.stringify(observations, null, 2));
        await page.screenshot({ path: info.outputPath(`native-${phase}.png`) });
        return value;
      };
      const inSync = async () => {
        const b = await read();
        return b?.state === "connected" && b.visible && !b.pending && b.size === paneSize()
          && JSON.stringify(normalized(b.screen)) === JSON.stringify(normalized(tmux("capture-pane", "-p", "-t", name).split("\n")));
      };
      try {
        await expect.poll(attached).toBeGreaterThan(0);
        const nativeSize = paneSize();
        tmux("send-keys", "-t", name, "printf '\\033[2J\\033[H'; i=1; while [ $i -le 80 ]; do printf 'NATIVE %03d 中文 │ output\\n' $i; i=$((i+1)); done; printf '%79sX\\nNATIVE_END\\n' ''", "Enter");
        await expect.poll(() => tmux("capture-pane", "-p", "-t", name).split("\n").some(line => line.trim() === "NATIVE_END")).toBe(true);
        await page.goto("/?debug=term"); await bindSecret(page);
        await page.evaluate(n => localStorage.setItem("tmux-hub.last-session", n), name);
        await page.reload();
        await expect.poll(async () => {
          await page.evaluate(n => window.__tmuxHub?.openSession?.(n), name);
          return inSync();
        }).toBe(true);
        await snapshot("initial");
        const before = (await read())!.measured;
        await page.setViewportSize(mobile ? { width: 390, height: 700 } : { width: 1000, height: 700 });
        await expect.poll(async () => (await read())!.measured).not.toBe(before);
        await snapshot("resize");
        expect(paneSize()).toBe(nativeSize);
        await expect.poll(inSync, { message: "native online resize must preserve actual pane grid and screen" }).toBe(true);
        // Real pointer interaction runs the shared reassert path on both views.
        await page.locator(".xterm-screen:visible").first().click({ position: { x: 20, y: 20 } });
        const cover = await context.newPage(); await cover.goto("about:blank"); await cover.bringToFront();
        await page.bringToFront(); await cover.close();
        if (other) {
          await page.locator(`.tab-bar__tab[data-session="${other}"]`).click();
          await page.locator(`.tab-bar__tab[data-session="${name}"]`).click();
        }
        await snapshot("interaction");
        expect(paneSize()).toBe(nativeSize); await expect.poll(inSync).toBe(true);
        // A real socket drop while native remains attached must also recover.
        const oldReplays = (await read())!.replays;
        await page.evaluate(n => window.__tmuxHubTerms![n]!.dropSocket(), name);
        await expect.poll(async () => (await read())!.replays).toBeGreaterThan(oldReplays);
        await expect.poll(inSync).toBe(true); expect(paneSize()).toBe(nativeSize);
        await snapshot("reconnect");
        const desired = (await read())!.measured;
        expect(desired).not.toBe(nativeSize);
        tmux("detach-client", "-s", name); await expect.poll(attached).toBe(0);
        await expect.poll(paneSize, { message: "native departure must reclaim actual current web layout" }).toBe(desired);
        await expect.poll(inSync).toBe(true);
        await snapshot("reclaimed");
      } finally {
        if (attached() > 0) tmux("detach-client", "-s", name);
        await context.close();
        if (native.exitCode === null) await new Promise<void>(resolve => { native.once("exit", () => resolve()); native.kill(); });
      }
    });
  }
}
