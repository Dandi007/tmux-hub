import type { Page, TestType, Expect, PlaywrightTestArgs, PlaywrightWorkerArgs } from "@playwright/test";
type Ctx = { tmuxE2E(args: string[]): string; createSession(templateId?: string): Promise<string> };

export function defineScrollIntentTests(
  test: TestType<PlaywrightTestArgs & { ctx: Ctx }, PlaywrightWorkerArgs>, expect: Expect,
  openSession: (page: Page, name: string) => Promise<void>,
  expectInSync: (page: Page, ctx: Ctx, name: string, why: string) => Promise<void>,
): void {
  for (const scenario of ["wheel-up", "replayed-up", "return-bottom", "no-input"] as const) {
    test(`scroll position survives disconnecting during a resize replay: ${scenario}`, async ({ page, ctx }) => {
      const name = await ctx.createSession();
      ctx.tmuxE2E(["send-keys", "-t", name,
        'i=0; while [ $i -lt 400 ]; do i=$((i+1)); printf "INTENT %03d\\n" "$i"; done', "Enter"]);
      await expect.poll(() => ctx.tmuxE2E(["capture-pane", "-p", "-t", name])).toContain("INTENT 400");
      let armed = false, reached!: () => void;
      const held = new Promise<void>((r) => { reached = r; });
      const afterBytes = scenario === "replayed-up" || scenario === "no-input";
      await page.routeWebSocket((u) => u.pathname === `/ws/sessions/${name}`, (route) => {
        const server = route.connectToServer();
        let active = false, holding = false;
        server.onMessage((message) => {
          if (holding) return; // All later frames on this connection stay in order until it closes.
          let kind: string | undefined;
          if (typeof message === "string") { try { kind = JSON.parse(message).kind; } catch {} }
          if (armed && kind === "resync") {
            armed = false; active = true; route.send(message);
            if (!afterBytes) { holding = true; reached(); }
            return;
          }
          if (active && afterBytes && kind === "scrollpos") { holding = true; reached(); return; }
          route.send(message);
        });
      });
      await openSession(page, name);
      await expectInSync(page, ctx, name, "before controlled network delay");
      await page.waitForTimeout(1000); // Initial layout finishes before the test's real resize.
      if (scenario === "return-bottom" || scenario === "no-input") {
        await page.evaluate((n) => window.__tmuxHubTerms![n]!.scrollLines(-60), name);
        expect(await page.evaluate((n) => window.__tmuxHubTerms![n]!.linesFromBottom, name)).toBe(60);
      }
      armed = true;
      const vp = page.viewportSize()!;
      await page.setViewportSize({ width: vp.width + (vp.width < 800 ? 24 : 120), height: vp.height });
      await held;
      if (afterBytes) await page.waitForTimeout(100); // Bytes parse while replay-done remains held.
      if (scenario === "wheel-up") {
        const box = await page.locator(".xterm-screen:visible").first().boundingBox();
        expect(box).not.toBeNull();
        await page.mouse.move(box!.x + 80, box!.y + 80);
        await page.mouse.wheel(0, -700);
        await expect.poll(() => page.evaluate((n) => window.__tmuxHubTerms![n]!.linesFromBottom, name)).toBeGreaterThan(0);
      }
      const before = await page.evaluate(([n, action]) => {
        const p = window.__tmuxHubTerms![n]!;
        if (action === "replayed-up") p.scrollLines(-60);
        if (action === "return-bottom") p.scrollLines(100000);
        const result = { scroll: p.linesFromBottom, replays: p.replays };
        p.dropSocket(); return result;
      }, [name, scenario] as const);
      if (scenario === "replayed-up") expect(before.scroll).toBe(60);
      if (scenario === "return-bottom" || scenario === "no-input") expect(before.scroll).toBe(0);
      const expected = scenario === "no-input" ? 60 : before.scroll;
      await expect.poll(() => page.evaluate((n) => window.__tmuxHubTerms![n]!.replays, name)).toBeGreaterThan(before.replays);
      await expect.poll(() => page.evaluate((n) => window.__tmuxHubTerms![n]!.linesFromBottom, name)).toBe(expected);
      await expectInSync(page, ctx, name, `after delayed replay and disconnect: ${scenario}`);
      await page.waitForTimeout(400);
      expect(await page.evaluate((n) => window.__tmuxHubTerms![n]!.linesFromBottom, name)).toBe(expected);
    });
  }
}
