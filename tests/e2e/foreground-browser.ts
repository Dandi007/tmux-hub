import { chromium, type Browser, type BrowserContext, type CDPSession } from "@playwright/test";
import { launchOwnedProcessGroup, type OwnedProcessGroup } from "../helpers/owned-process-group";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Playwright does not own our CDP metrics override. Its screenshot cleanup
 * resets that viewport; capture directly without changing the tested layout. */
export async function captureForegroundScreenshot(cdp: CDPSession, path: string): Promise<void> {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(path, Buffer.from(data, "base64"));
}

/** Playwright normally enables focus emulation, keeping background pages visible.
 * Attach to an owned Chromium default context without that override so tests
 * exercise native visibilitychange events. No X server is needed. */
export async function withForegroundContext(
  logPath: string,
  run: (context: BrowserContext) => Promise<void>,
  profileRoot = tmpdir(),
  callbackTimeoutMs = 40_000,
  onLaunch?: (owned: OwnedProcessGroup) => void,
): Promise<void> {
  const profile = mkdtempSync(join(profileRoot, "tmux-hub-foreground-"));
  let owned: OwnedProcessGroup | undefined;
  let browser: Browser | undefined;
  let log: number | undefined;
  try {
    for (const dir of ["config", "cache", "data"]) mkdirSync(join(profile, dir));
    log = openSync(logPath, "w");
    owned = launchOwnedProcessGroup(chromium.executablePath(), [
      "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--password-store=basic",
      "--disable-background-networking", "--no-first-run", "--no-default-browser-check",
      "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
      `--user-data-dir=${profile}`, "about:blank",
    ], log, { ...process.env, XDG_CONFIG_HOME: join(profile, "config"),
      XDG_CACHE_HOME: join(profile, "cache"), XDG_DATA_HOME: join(profile, "data") });
    onLaunch?.(owned);
    closeSync(log);
    log = undefined;
    const discovery = join(profile, "DevToolsActivePort");
    for (let i = 0; i < 100 && !existsSync(discovery); i++) {
      if (owned.error) throw owned.error;
      if (owned.process.exitCode !== null || owned.process.signalCode !== null) throw new Error("foreground group exited before CDP discovery");
      await sleep(50);
    }
    const port = readFileSync(discovery, "utf8").split("\n")[0];
    if (!/^\d+$/.test(port ?? "")) throw new Error("invalid foreground Chromium CDP port");
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true, timeout: 10_000 });
    const context = browser.contexts()[0];
    if (!context) throw new Error("foreground Chromium default context missing");
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([run(context), new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("foreground callback timed out")), callbackTimeoutMs);
      })]);
    } finally {
      clearTimeout(deadline);
    }
  } finally {
    if (log !== undefined) closeSync(log);
    try {
      // CDP-connected browser.close() only detaches. Ask the owned browser to
      // exit first so descendants stop writing their profile before removal.
      if (browser?.isConnected()) {
        await Promise.race([(async () => {
          const cdp = await browser.newBrowserCDPSession();
          await cdp.send("Browser.close");
        })().catch(() => {}), sleep(1000)]);
        await Promise.race([browser.close().catch(() => {}), sleep(1000)]);
      }
    } finally {
      try { await owned?.stop(); }
      finally { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    }
  }
}
