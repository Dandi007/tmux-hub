import type { Browser, Expect, PlaywrightTestArgs, PlaywrightWorkerArgs, TestType } from "@playwright/test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OwnedProcessGroup } from "../helpers/owned-process-group";
import { withForegroundContext } from "./foreground-browser";

export function defineForegroundCleanupTests<T extends PlaywrightTestArgs>(test: TestType<T, PlaywrightWorkerArgs>, expect: Expect): void {
  test("a stalled callback after CDP disconnect releases its browser process and profile", async ({}, info) => {
    test.setTimeout(60_000);
    const root = mkdtempSync(join(tmpdir(), "foreground-timeout-test-"));
    let browser: Browser | null = null;
    let owned: OwnedProcessGroup | undefined;
    let pid = 0;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    try {
      const result = withForegroundContext(info.outputPath("stalled-browser.log"), async (context) => {
        browser = context.browser();
        const cdp = await browser!.newBrowserCDPSession();
        const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
        pid = processInfo.find((p) => p.type === "browser")!.id;
        await browser!.close(); // Disconnect the CDP transport, leaving the owned Chromium alive.
        expect(browser!.isConnected()).toBe(false);
        expect(owned!.process.exitCode).toBeNull();
        expect(owned!.process.signalCode).toBeNull();
        process.kill(pid, 0);
        entered();
        await new Promise<void>(() => {});
      }, root, 1000, (child) => { owned = child; }).then(() => "unexpected success", (e) => String(e));
      await Promise.race([ready, result.then((error) => { throw new Error(error); })]);
      // An independent guard makes the red regression finite and permits our
      // own fallback cleanup; a hung helper must not leak during this test.
      const outcome = await Promise.race([result, new Promise<string>((resolve) => setTimeout(() => resolve("external guard expired"), 4000))]);
      expect(outcome).toContain("foreground callback timed out");
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(readdirSync(root)).toEqual([]);
    } finally {
      try {
        if (browser?.isConnected()) {
          const cdp = await browser.newBrowserCDPSession();
          await cdp.send("Browser.close").catch(() => {});
          await browser.close().catch(() => {});
        }
      } finally {
        try {
          await owned?.stop();
        } finally {
          rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
      }
    }
  });
}
