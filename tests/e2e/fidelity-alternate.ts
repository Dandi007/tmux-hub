import type { Page, TestType, Expect, PlaywrightTestArgs, PlaywrightWorkerArgs } from "@playwright/test";

type Ctx = { tmuxE2E(args: string[]): string; createSession(templateId?: string): Promise<string> };

export function defineAlternateTests(
  test: TestType<PlaywrightTestArgs & { ctx: Ctx }, PlaywrightWorkerArgs>, expect: Expect,
  openSession: (page: Page, name: string) => Promise<void>,
  expectInSync: (page: Page, ctx: Ctx, name: string, why: string) => Promise<void>,
): void {
  for (const weak of [false, true]) for (const entry of ["offline-entry", "fresh-attach"]) {
    test(`ordinary alternate snapshot preserves screens through wheel, resize and exit: ${entry} ${weak ? "weak" : "normal"}`, async ({ page, ctx }, info) => {
      test.setTimeout(60_000);
      const name = await ctx.createSession();
      const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
      let delayed = 0;
      if (weak) await page.routeWebSocket(u => u.pathname === `/ws/sessions/${name}`, route => {
        const server = route.connectToServer(); let tail = Promise.resolve();
        server.onMessage(message => {
          // Delay only actual frames, in order; no replacement snapshots.
          tail = tail.then(async () => { await sleep(25); delayed++; try { route.send(message); } catch {} });
        });
      });
      ctx.tmuxE2E(["send-keys", "-t", name,
        'i=1; while [ $i -le 800 ]; do printf "ALT_SEED %03d end\\n" "$i"; i=$((i+1)); done', "Enter"]);
      await expect.poll(() => ctx.tmuxE2E(["capture-pane", "-p", "-t", name]).split("\n").includes("ALT_SEED 800 end")).toBe(true);
      await openSession(page, name);
      await expectInSync(page, ctx, name, "normal before alternate");
      const view = () => page.evaluate(n => {
        const p = window.__tmuxHubTerms![n]!;
        return { replays: p.replays, scroll: p.linesFromBottom, size: `${p.cols}x${p.rows}`, state: p.state };
      }, name);
      const enter = () => ctx.tmuxE2E(["send-keys", "-t", name, "printf '\\033[?1049h\\033[HALT_ORDINARY\\n'", "Enter"]);
      const serverAlt = () => ctx.tmuxE2E(["display", "-p", "-t", name, "#{alternate_on}"]);
      const before = await view();
      if (entry === "offline-entry") {
        await page.evaluate(n => window.__tmuxHubTerms![n]!.dropSocket(), name);
        await expect.poll(async () => (await view()).state).toBe("reconnecting");
        enter();
        await expect.poll(serverAlt).toBe("1");
        await expect.poll(async () => (await view()).replays).toBeGreaterThan(before.replays);
      } else {
        enter(); await expect.poll(serverAlt).toBe("1");
        await page.reload();
        await expect.poll(() => page.evaluate(n => window.__tmuxHubTerms?.[n]?.visible, name)).toBe(true);
      }
      await expectInSync(page, ctx, name, "alternate replay");
      const wheel = async () => {
        const box = await page.locator(".xterm-screen:visible").first().boundingBox();
        if (!box) throw new Error("no visible terminal");
        await page.mouse.move(box.x + 50, box.y + 50); await page.mouse.wheel(0, -420);
        await page.waitForTimeout(250);
      };
      const grid = (await view()).size;
      await wheel();
      expect(serverAlt()).toBe("1"); expect((await view()).size).toBe(grid);
      expect((await view()).scroll).toBe(0);
      await expectInSync(page, ctx, name, "wheel stays in alternate screen");
      const vp = page.viewportSize(); if (!vp) throw new Error("missing viewport");
      const resizes = (await page.evaluate(n => window.__tmuxHubTerms![n]!.resyncs, name));
      await page.setViewportSize({ width: vp.width + 80, height: vp.height + 40 });
      await expect.poll(() => page.evaluate(n => window.__tmuxHubTerms![n]!.resyncs, name)).toBeGreaterThan(resizes);
      await expectInSync(page, ctx, name, "alternate resize");
      await wheel(); expect((await view()).scroll).toBe(0);
      await page.screenshot({ path: info.outputPath("alternate-wheel.png") });
      // Alternate-scroll forwards cursor keys to the application. Our fixture
      // is an interactive shell; clear any history recalled by those keys
      // before asking it to exit alternate mode.
      ctx.tmuxE2E(["send-keys", "-t", name, "C-u"]);
      ctx.tmuxE2E(["send-keys", "-t", name, "printf '\\033[?1049lNORMAL_ORDINARY\\n'", "Enter"]);
      await expect.poll(serverAlt).toBe("0");
      await expectInSync(page, ctx, name, "live exit restores normal screen");
      await wheel(); expect((await view()).scroll).toBeGreaterThan(0);
      const chosen = (await view()).scroll, replay = (await view()).replays;
      await page.evaluate(n => window.__tmuxHubTerms![n]!.dropSocket(), name);
      await expect.poll(async () => (await view()).replays).toBeGreaterThan(replay);
      await expect.poll(async () => (await view()).scroll).toBe(chosen);
      await expectInSync(page, ctx, name, "normal history still navigates and reconnects");
      if (weak) expect(delayed).toBeGreaterThan(0);
    });
  }
}
