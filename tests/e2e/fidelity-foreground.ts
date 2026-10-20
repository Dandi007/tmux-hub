import type { Page, TestType, Expect, PlaywrightTestArgs, PlaywrightWorkerArgs } from "@playwright/test";
import { captureForegroundScreenshot, withForegroundContext } from "./foreground-browser";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

type Ctx = { tmuxE2E(args: string[]): string; createSession(templateId?: string): Promise<string> };

export function defineForegroundTests(
  test: TestType<PlaywrightTestArgs & { ctx: Ctx }, PlaywrightWorkerArgs>, expect: Expect,
  expectInSync: (page: Page, ctx: Ctx, name: string, why: string) => Promise<void>,
  scenarios: readonly string[] = ["history", "history-two-reconnects", "history-resize", "history-alt-switch", "history-alt-queued", "history-overlap", "history-overlap-alt", "history-pending-wheel", "history-pending-no-input", "following"],
): void {
  for (const scenario of scenarios) {
    test(`background browser reconnect preserves scroll position on foreground: ${scenario}`, async ({ ctx }, info) => {
      // Include bounded owned-browser startup/teardown; app polls stay 5/10s.
      test.setTimeout(90_000);
      const overlapping = scenario === "history-overlap" || scenario === "history-overlap-alt";
      const pending = scenario.startsWith("history-pending-");
      let chosenLfb = 60;
      const name = await ctx.createSession();
      const auth = await fetch(`${info.project.use.baseURL}/system/auth-check`, { signal: AbortSignal.timeout(2000) });
      if (!auth.ok) throw new Error(`test auth-check failed: ${auth.status}`);
      const { secret } = await auth.json() as { secret: string };
      ctx.tmuxE2E(["send-keys", "-t", name,
        'i=0; while [ $i -lt 800 ]; do i=$((i+1)); printf "FOREGROUND %03d end\\n" "$i"; done', "Enter"]);
      await expect.poll(() => ctx.tmuxE2E(["capture-pane", "-p", "-t", name]).split("\n").includes("FOREGROUND 800 end")).toBe(true);
      const stages: { at: number; name: string }[] = [];
      const stage = (name: string) => {
        stages.push({ at: Date.now(), name });
        writeFileSync(info.outputPath("foreground-stages.json"), JSON.stringify(stages));
      };
      await withForegroundContext(info.outputPath("foreground-browser.log"), async (context) => {
        stage("create-page");
        const page = await context.newPage();
        try {
        stage("configure-page");
        await page.bringToFront();
        const cdp = await context.newCDPSession(page);
        const mobile = Boolean(info.project.use.isMobile);
        const vp = info.project.use.viewport || { width: 1440, height: 900 };
        const metrics = { ...vp, mobile, deviceScaleFactor: 1 };
        await cdp.send("Emulation.setDeviceMetricsOverride", metrics);
        if (mobile) await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
        await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
        await page.addInitScript(() => {
          (window as any).__visibilityEvents = [];
          document.addEventListener("visibilitychange", () => {
            (window as any).__visibilityEvents.push(document.visibilityState);
          });
        });
        if (scenario === "history-alt-queued" || overlapping || pending) await page.addInitScript(({ n, overlap, altReplay, pending }) => {
          const Native = window.WebSocket;
          window.WebSocket = class extends Native {
            set onmessage(handler) {
              if (pending && handler && this.url.includes(`/ws/sessions/${encodeURIComponent(n)}?`)) (window as any).__foregroundSocket = this;
              super.onmessage = handler ? function (event) {
                if (!this.url.includes(`/ws/sessions/${encodeURIComponent(n)}?`)) {
                  handler.call(this, event); return;
                }
                const data = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
                const gate = (window as any).__overlap;
                if ((overlap || pending) && gate) {
                  let kind = "";
                  if (typeof event.data === "string") { try { kind = JSON.parse(data).kind; } catch {} }
                  if (pending && kind === "resync" && gate.phase === "armedUser") gate.phase = "userB";
                  if (pending && kind === "scrollpos" && (gate.phase === "userB" || gate.phase === "heldUserB")) {
                    gate.phase = "heldUserB"; return;
                  }
                  if (altReplay && gate.phase === "armed" && typeof event.data !== "string") {
                    // Exercise the production emulator fallback's mode-preserving
                    // snapshot. The normal capture-pane path omits alt mode.
                    if (!gate.alternateInjected && data.includes("\x1bc")) {
                      gate.alternateInjected = true;
                      handler.call(this, new MessageEvent("message", {
                        data: new TextEncoder().encode((window as any).__alternateReplay).buffer,
                      }));
                    }
                    return;
                  }
                  if (altReplay && gate.phase === "heldA" && typeof event.data !== "string") return;
                  if (kind === "scrollpos" && gate.phase === "armed") {
                    gate.held = event; gate.phase = "heldA"; return;
                  }
                  if (kind === "resync" && gate.phase === "heldA") {
                    // Release the real old completion, then deliver the real
                    // new resync before xterm can run that completion callback.
                    handler.call(this, gate.held); gate.phase = "B";
                  } else if (kind === "scrollpos" && gate.phase === "B") {
                    gate.phase = "heldB"; return;
                  }
                }
                if (overlap && gate && (gate.phase === "B" || gate.phase === "heldB") && typeof event.data !== "string") {
                  if (gate.prefixOnly) return;
                  const bytes = new Uint8Array(event.data);
                  const reset = bytes.findIndex((b, i) => b === 27 && bytes[i + 1] === 99);
                  if (reset >= 0) {
                    // Stall the real snapshot immediately after its real RIS.
                    // Do not invent bytes or a replay completion notification.
                    gate.prefixOnly = true;
                    handler.call(this, new MessageEvent("message", { data: bytes.slice(0, reset + 2).buffer }));
                    return;
                  }
                }
                handler.call(this, event);
                if (!overlap && !pending && data.includes("\x1b[?1049h") && data.includes("ALT_READY")) {
                  const p = window.__tmuxHubTerms![n]!;
                  (window as any).__queuedAltDrop = { parsed: p.screen().some((line) => line.trim() === "ALT_READY") };
                  // Close the real transport and deliver its close notification
                  // in this task, before xterm's asynchronous parser runs.
                  const closed = this.onclose;
                  this.close();
                  closed?.call(this, new CloseEvent("close", { code: 1006 }));
                }
              } : null;
            }
          };
        }, { n: name, overlap: overlapping, altReplay: scenario === "history-overlap-alt", pending });
        const url = `${info.project.use.baseURL}/?debug=term`;
        await page.addInitScript(({ n, s }) => {
          sessionStorage.setItem("hub.secret", s);
          localStorage.setItem("tmux-hub.last-session", n);
        }, { n: name, s: secret });
        stage("authenticated-navigation");
        await page.goto(url, { waitUntil: "domcontentloaded" }); await page.bringToFront();
        stage("initial-terminal");
        // Wait for the product's EventSource to surface the managed fixture,
        // then select it once through the real UI. No separate SSE reader or
        // repeated debug opener can race the asynchronous registry scan.
        const item = page.locator(`${mobile ? ".session-picker__item" : ".tab-bar__tab"}[data-session="${name}"]`);
        await expect(item).toBeAttached();
        if (mobile) await page.locator(".session-picker__trigger").click();
        await item.click();
        await expect.poll(() => page.evaluate((n) => window.__tmuxHubTerms?.[n]?.visible, name)).toBe(true);
        await expectInSync(page, ctx, name, "before native browser backgrounding");
        await expect.poll(() => page.evaluate((n) => window.__tmuxHubTerms![n]!.replays, name)).toBeGreaterThan(0);
        await page.waitForTimeout(250); // Finish initial layout before navigating history.
        const lfb = scenario === "following" ? 0 : 60;
        if (lfb) await page.evaluate((n) => window.__tmuxHubTerms![n]!.scrollLines(-60), name);
        expect(await page.evaluate((n) => window.__tmuxHubTerms![n]!.linesFromBottom, name)).toBe(lfb);
        const paneBefore = ctx.tmuxE2E(["display", "-p", "-t", name, "#{pane_width}x#{pane_height}"]);
        if (scenario === "history-overlap-alt") {
          const [cols, rows] = paneBefore.trim().split("x").map(Number);
          // Use the server's Bun runtime; @xterm/headless's named CJS exports
          // cannot be imported by the Node Playwright worker directly.
          const generated = spawnSync("bun", ["-e", `
            import { SessionEmulator } from "./src/server/session-emulator";
            const e = new SessionEmulator(${cols}, ${rows}, 1000);
            e.write("\\x1b[?1049hALT_READY\\r\\n");
            console.log(JSON.stringify(e.snapshot())); e.dispose();
          `], { cwd: process.cwd(), encoding: "utf8", timeout: 5000 });
          expect(generated.status).toBe(0);
          const replay = JSON.parse(generated.stdout) as string;
          expect(replay).toContain("\x1b[?1049h");
          await page.evaluate((replay) => { (window as any).__alternateReplay = replay; }, replay);
        }
        const cover = await context.newPage(); await cover.goto("data:text/html,other-tab"); await cover.bringToFront();
        const coverCdp = await context.newCDPSession(cover);
        await coverCdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
        stage("background-reconnect");
        await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("hidden");
        if (overlapping) await page.evaluate(() => { (window as any).__overlap = { phase: "armed" }; });
        for (let i = 0; i < (scenario === "history-two-reconnects" ? 2 : 1); i++) {
          const before = await page.evaluate((n) => {
            const p = window.__tmuxHubTerms![n]!; const replays = p.replays; p.dropSocket(); return replays;
          }, name);
          if (scenario === "history-overlap-alt") {
            await expect.poll(() => page.evaluate((n) => window.__tmuxHubTerms![n]!.state, name)).toBe("reconnecting");
            ctx.tmuxE2E(["send-keys", "-t", name, "printf '\\033[?1049hALT_READY\\n'", "Enter"]);
            await expect.poll(() => ctx.tmuxE2E(["display", "-p", "-t", name, "#{alternate_on}"]).trim()).toBe("1");
          }
          if (overlapping) {
            await expect.poll(() => page.evaluate(() => (window as any).__overlap.phase)).toBe("heldA");
          } else {
            await expect.poll(() => page.evaluate((n) => window.__tmuxHubTerms![n]!.replays, name)).toBeGreaterThan(before);
          }
          expect(await page.evaluate(() => document.visibilityState)).toBe("hidden");
        }
        if (scenario === "history-overlap-alt") {
          expect(await page.evaluate(() => (window as any).__overlap.alternateInjected)).toBe(true);
          await expect.poll(() => page.evaluate((n) => window.__tmuxHubTerms![n]!.screen().some((line) => line.trim() === "ALT_READY"), name)).toBe(true);
          ctx.tmuxE2E(["send-keys", "-t", name, "printf '\\033[?1049lNORMAL_READY\\n'", "Enter"]);
          await expect.poll(() => ctx.tmuxE2E(["display", "-p", "-t", name, "#{alternate_on}"]).trim()).toBe("0");
        }
        if (overlapping) {
          await cdp.send("Emulation.setDeviceMetricsOverride", { ...metrics, width: vp.width + 48, height: vp.height + 40 });
          expect(ctx.tmuxE2E(["display", "-p", "-t", name, "#{pane_width}x#{pane_height}"])).toBe(paneBefore);
          await page.bringToFront();
          await expect.poll(() => page.evaluate(() => (window as any).__overlap.phase)).toBe("heldB");
          await expect.poll(() => page.evaluate(() => (window as any).__overlap.prefixOnly)).toBe(true);
          await expect.poll(() => page.evaluate((n) => window.__tmuxHubTerms![n]!.screen().every((line) => !line.trim()), name)).toBe(true);
          await expect.poll(() => page.evaluate((n) => window.__tmuxHubTerms![n]!.linesFromBottom, name)).toBe(0);
          const before = await page.evaluate((n) => {
            (window as any).__overlap.phase = "done";
            const p = window.__tmuxHubTerms![n]!; const replays = p.replays; p.dropSocket(); return replays;
          }, name);
          await expect.poll(() => page.evaluate((n) => window.__tmuxHubTerms![n]!.replays, name)).toBeGreaterThan(before);
        }
        if (pending) {
          await page.evaluate((n) => {
            (window as any).__overlap = { phase: "armedUser" };
            const p = window.__tmuxHubTerms![n]!;
            (window as any).__foregroundSocket.send(JSON.stringify({ kind: "resize", cols: p.cols + 1, rows: p.rows }));
          }, name);
          await expect.poll(() => page.evaluate(() => (window as any).__overlap.phase)).toBe("heldUserB");
          expect(await page.evaluate(() => document.visibilityState)).toBe("hidden");
          await page.bringToFront();
          await expectInSync(page, ctx, name, "foreground replay bytes parsed with completion held");
          if (scenario === "history-pending-wheel") {
            const box = await page.locator(".xterm-screen:visible").first().boundingBox();
            expect(box).not.toBeNull();
            await page.mouse.move(box!.x + 80, box!.y + 80);
            await page.mouse.wheel(0, -420);
            await expect.poll(() => page.evaluate((n) => window.__tmuxHubTerms![n]!.linesFromBottom, name)).toBeGreaterThan(0);
            await page.waitForTimeout(100);
            chosenLfb = await page.evaluate((n) => window.__tmuxHubTerms![n]!.linesFromBottom, name);
            expect(chosenLfb).not.toBe(60);
          }
          const before = await page.evaluate((n) => {
            (window as any).__overlap.phase = "done";
            const p = window.__tmuxHubTerms![n]!; const replays = p.replays; p.dropSocket(); return replays;
          }, name);
          await expect.poll(() => page.evaluate((n) => window.__tmuxHubTerms![n]!.replays, name)).toBeGreaterThan(before);
        }
        if (scenario.startsWith("history-alt-")) {
          const before = await page.evaluate((n) => window.__tmuxHubTerms![n]!.replays, name);
          ctx.tmuxE2E(["send-keys", "-t", name, "printf '\\033[?1049hALT_READY\\n'", "Enter"]);
          await expect.poll(() => ctx.tmuxE2E(["display", "-p", "-t", name, "#{alternate_on}"]).trim()).toBe("1");
          if (scenario === "history-alt-queued") {
            await expect.poll(() => page.evaluate(() => (window as any).__queuedAltDrop)).toEqual({ parsed: false });
          } else {
            await expect.poll(() => page.evaluate((n) => window.__tmuxHubTerms![n]!.screen().some((line) => line.trim() === "ALT_READY"), name)).toBe(true);
            await page.evaluate((n) => window.__tmuxHubTerms![n]!.dropSocket(), name);
          }
          ctx.tmuxE2E(["send-keys", "-t", name, "printf '\\033[?1049lNORMAL_READY\\n'", "Enter"]);
          await expect.poll(() => ctx.tmuxE2E(["display", "-p", "-t", name, "#{alternate_on}"]).trim()).toBe("0");
          await expect.poll(() => page.evaluate((n) => window.__tmuxHubTerms![n]!.replays, name)).toBeGreaterThan(before);
          expect(await page.evaluate(() => document.visibilityState)).toBe("hidden");
        }
        if (scenario === "history-resize") {
          await cdp.send("Emulation.setDeviceMetricsOverride", { ...metrics, width: vp.width + 48, height: vp.height + 40 });
          await page.waitForTimeout(250);
        }
        if (!overlapping && !pending) expect(ctx.tmuxE2E(["display", "-p", "-t", name, "#{pane_width}x#{pane_height}"])).toBe(paneBefore);
        const restoredLfb = scenario.startsWith("history-alt-") || scenario === "history-overlap-alt" ? 0 : pending ? chosenLfb : lfb;
        stage("restore-foreground");
        await page.bringToFront();
        await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("visible");
        await expect.poll(() => page.evaluate((n) => window.__tmuxHubTerms![n]!.linesFromBottom, name)).toBe(restoredLfb);
        await expectInSync(page, ctx, name, "after native browser foregrounding");
        if (scenario === "history-resize") {
          // Both layout axes grow; matching two stale grids is insufficient.
          const [cols, rows] = paneBefore.trim().split("x").map(Number);
          await expect.poll(async () => {
            const p = await page.evaluate((n) => {
              const t = window.__tmuxHubTerms![n]!; return { cols: t.cols, rows: t.rows };
            }, name);
            return p.cols > cols! && p.rows > rows!;
          }).toBe(true);
        }
        await page.waitForTimeout(350);
        expect(await page.evaluate((n) => window.__tmuxHubTerms![n]!.linesFromBottom, name)).toBe(restoredLfb);
        expect(await page.evaluate(() => (window as any).__visibilityEvents)).toEqual(["hidden", "visible"]);
        const capturedGeometry = await page.evaluate((n) => {
          const p = window.__tmuxHubTerms![n]!; return `${p.cols}x${p.rows}`;
        }, name);
        await captureForegroundScreenshot(cdp, info.outputPath("foreground-restored.png"));
        expect(await page.evaluate((n) => {
          const p = window.__tmuxHubTerms![n]!; return `${p.cols}x${p.rows}`;
        }, name)).toBe(capturedGeometry);
        stage("close-pages");
        await cover.close(); await page.close();
        stage("complete");
        } catch (error) {
          const evidence = await page.evaluate((n) => {
            const p = window.__tmuxHubTerms?.[n];
            return { visibility: document.visibilityState, events: (window as any).__visibilityEvents,
              term: p ? { visible: p.visible, state: p.state, scroll: p.linesFromBottom, replays: p.replays, screen: p.screen() } : null };
          }, name).catch(() => ({ closed: true }));
          writeFileSync(info.outputPath("foreground-failure.json"), JSON.stringify(evidence));
          await captureForegroundScreenshot(await context.newCDPSession(page), info.outputPath("foreground-failure.png")).catch(() => {});
          throw error;
        }
      });
    });
  }
}
