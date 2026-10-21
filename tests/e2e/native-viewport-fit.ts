import { test, expect } from "./emulator-fixtures";
import { bindSecret } from "./helpers";
import { spawn, type ChildProcess } from "node:child_process";
import type { CDPSession, Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { captureForegroundScreenshot, withForegroundContext } from "./foreground-browser";

const normalized = (lines: string[]) => {
  const result = lines.map(line => line.trimEnd());
  while (result.at(-1) === "") result.pop();
  return result;
};

async function stopNative(child: ChildProcess): Promise<void> {
  const alive = () => child.exitCode === null && child.signalCode === null && child.pid !== undefined;
  if (!alive()) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ended!: () => void;
  const exited = new Promise<void>(resolve => { ended = resolve; });
  child.once("exit", ended);
  try {
    child.kill();
    await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]);
    clearTimeout(timer);
    if (alive()) {
      child.kill("SIGKILL");
      await Promise.race([exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("native TTY child did not exit")), 2000);
      })]);
    }
  } finally {
    clearTimeout(timer); child.removeListener("exit", ended); child.stdin?.destroy();
  }
}

export function defineNativeViewportFitTests() {
  for (const mobile of [false, true]) {
    test(`native online ${mobile ? "phone" : "desktop"} keeps its pane grid through layout and interaction`, async ({ baseURL, ctx }, info) => {
      test.setTimeout(60_000); // Owned-browser startup/teardown; behavior polls remain5s.
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
      let launchError: Error | undefined;
      native.once("error", error => { launchError = error; });
      let page: Page;
      let cdp: CDPSession;
      const observations: unknown[] = [];
      const read = () => page.evaluate(n => {
        const p = window.__tmuxHubTerms?.[n];
        return p ? { size: `${p.cols}x${p.rows}`, measured: p.measuredSize, screen: p.screen(), state: p.state, visible: p.visible, replays: p.replays, pending: p.replayPending, scroll: p.linesFromBottom, visibility: document.visibilityState, visibilityEvents: (window as any).__nativeVisibility } : null;
      }, name);
      const snapshot = async (phase: string) => {
        const value = { phase, browser: await read(), pane: { size: paneSize(), screen: tmux("capture-pane", "-p", "-t", name).split("\n") }, attached: attached() };
        observations.push(value);
        writeFileSync(info.outputPath("native-online.json"), JSON.stringify(observations, null, 2));
        await captureForegroundScreenshot(cdp, info.outputPath(`native-${phase}.png`));
        return value;
      };
      const inSync = async () => {
        const b = await read();
        return b?.state === "connected" && b.visible && !b.pending && b.scroll === 0 && b.size === paneSize()
          && JSON.stringify(normalized(b.screen)) === JSON.stringify(normalized(tmux("capture-pane", "-p", "-t", name).split("\n")));
      };
      try {
        await withForegroundContext(info.outputPath("native-browser.log"), async context => {
        page = await context.newPage(); cdp = await context.newCDPSession(page);
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: mobile ? 430 : 1400, height: 900, mobile, deviceScaleFactor: 1 });
        await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
        if (mobile) await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
        await page.addInitScript(() => {
          (window as any).__nativeVisibility = [];
          document.addEventListener("visibilitychange", () => (window as any).__nativeVisibility.push(document.visibilityState));
        });
        await expect.poll(() => { if (launchError) throw launchError; return attached(); }).toBeGreaterThan(0);
        const nativeSize = paneSize();
        tmux("send-keys", "-t", name, "printf '\\033[2J\\033[H'; i=1; while [ $i -le 80 ]; do printf 'NATIVE %03d 中文 │ output\\n' $i; i=$((i+1)); done; printf '%79sX\\nNATIVE_END\\n' ''", "Enter");
        await expect.poll(() => tmux("capture-pane", "-p", "-t", name).split("\n").some(line => line.trim() === "NATIVE_END")).toBe(true);
        await page.goto(new URL("/?debug=term", baseURL).href); await bindSecret(page);
        await page.evaluate(n => localStorage.setItem("tmux-hub.last-session", n), name);
        await page.reload(); await page.bringToFront();
        await expect.poll(async () => {
          await page.evaluate(n => window.__tmuxHub?.openSession?.(n), name);
          return inSync();
        }).toBe(true);
        await snapshot("initial");
        const before = (await read())!.measured;
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: mobile ? 390 : 1000, height: 700, mobile, deviceScaleFactor: 1 });
        await expect.poll(async () => (await read())!.measured).not.toBe(before);
        await snapshot("resize");
        expect(paneSize()).toBe(nativeSize);
        await expect.poll(inSync, { message: "native online resize must preserve actual pane grid and screen" }).toBe(true);
        // Real pointer interaction runs the shared reassert path on both views.
        await page.locator(".xterm-screen:visible").first().click({ position: { x: 20, y: 20 } });
        await page.evaluate(() => { (window as any).__nativeVisibility = []; });
        const cover = await context.newPage();
        await (await context.newCDPSession(cover)).send("Emulation.setFocusEmulationEnabled", { enabled: false });
        await cover.goto("about:blank"); await cover.bringToFront();
        await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("hidden");
        await page.bringToFront();
        await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("visible");
        expect(await page.evaluate(() => (window as any).__nativeVisibility)).toEqual(["hidden", "visible"]);
        await cover.close();
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
        await page.close();
        });
      } finally {
        try {
          if (attached() > 0) tmux("detach-client", "-s", name);
        } finally {
          await stopNative(native);
        }
      }
    });
  }
}
