import type { Page, TestType, Expect, PlaywrightTestArgs, PlaywrightWorkerArgs } from "@playwright/test";

type Ctx = { tmuxE2E(args: string[]): string; createSession(templateId?: string): Promise<string> };

export function defineReconnectQueueTest(
  test: TestType<PlaywrightTestArgs & { ctx: Ctx }, PlaywrightWorkerArgs>,
  expect: Expect,
  openSession: (page: Page, name: string) => Promise<void>,
  expectInSync: (page: Page, ctx: Ctx, name: string, why: string) => Promise<void>,
): void {
  test("first reconnect at unchanged geometry keeps a returned-to-bottom viewport at the bottom", async ({ page, ctx }) => {
    const name = await ctx.createSession();
    ctx.tmuxE2E(["send-keys", "-t", name,
      'i=0; while [ $i -lt 200 ]; do i=$((i+1)); printf "QUEUEHIST %03d\\n" "$i"; done', "Enter"]);
    await expect.poll(() => ctx.tmuxE2E(["capture-pane", "-p", "-t", name])).toContain("QUEUEHIST 200");
    await openSession(page, name);
    await expectInSync(page, ctx, name, "before first reconnect");
    // Let the legitimate initial layout adjustment finish; no window or pane
    // geometry changes are requested after this point.
    await page.waitForTimeout(1500);
    const before = await page.evaluate((n) => {
      const p = window.__tmuxHubTerms![n]!;
      p.scrollLines(-60);
      const value = { replays: p.replays, resyncs: p.resyncs, scroll: p.linesFromBottom };
      p.dropSocket();
      return value;
    }, name);
    expect(before.scroll).toBe(60);
    await page.waitForFunction(([n, replays]) => {
      const p = window.__tmuxHubTerms![n]!;
      return p.replays > replays && p.linesFromBottom === 60;
    }, [name, before.replays] as const, { polling: 5 });

    // Exercise the user action while any unexpected replay is in progress.
    // This only observes a real server resync; it never injects or delays it.
    // The fixed path (and phone view) has no extra resync and uses the timeout.
    await page.waitForFunction(([n, count]) => window.__tmuxHubTerms![n]!.resyncs > count,
      [name, before.resyncs] as const, { polling: 5, timeout: 2000 }).catch((e: Error) => {
      if (e.name !== "TimeoutError") throw e;
    });
    const returned = await page.evaluate((n) => {
      const p = window.__tmuxHubTerms![n]!;
      p.scrollLines(100000);
      const scroll = p.linesFromBottom;
      p.dropSocket();
      return scroll;
    }, name);
    expect(returned).toBe(0);
    // The reconnect delay is up to 650ms plus snapshot parsing. Check twice
    // after that so the old pre-replay bottom cannot masquerade as recovery.
    await page.waitForTimeout(1100);
    await expectInSync(page, ctx, name, "after returning to bottom and disconnecting again");
    expect(await page.evaluate((n) => window.__tmuxHubTerms![n]!.linesFromBottom, name)).toBe(0);
    await page.waitForTimeout(1000);
    expect(await page.evaluate((n) => window.__tmuxHubTerms![n]!.linesFromBottom, name)).toBe(0);
  });
}
