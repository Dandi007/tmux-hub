import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import type { Page, TestType, Expect, PlaywrightTestArgs, PlaywrightWorkerArgs } from "@playwright/test";
type Ctx = { tmuxE2E(args: string[]): string; createSession(templateId?: string): Promise<string> };

export function defineScrollIntentTests(
  test: TestType<PlaywrightTestArgs & { ctx: Ctx }, PlaywrightWorkerArgs>, expect: Expect,
  openSession: (page: Page, name: string) => Promise<void>,
  expectInSync: (page: Page, ctx: Ctx, name: string, why: string) => Promise<void>,
): void {
  test("replay shrinking the DOM scroll area cannot interrupt streaming follow-bottom", async ({ page }) => {
    const require = createRequire(import.meta.url);
    await page.setContent('<div id="term" style="width:900px;height:500px"></div>');
    await page.addStyleTag({ path: require.resolve("xterm/css/xterm.css") });
    await page.addScriptTag({ path: require.resolve("xterm") });
    // Exercise the actual observer with a real browser/xterm. No hub or parser
    // state is mocked; force one render between the replay and live chunks.
    const observer = ts.transpileModule(readFileSync("src/web/scroll-intent.ts", "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    await page.addScriptTag({ content: `var exports = {}; ${observer}; window.observeIntent = exports.observeScrollIntent;` });
    const result = await page.evaluate(async () => {
      const w = window as any;
      const term = new w.Terminal({ cols: 80, rows: 24, scrollback: 10000 });
      term.open(document.querySelector("#term"));
      const viewport = document.querySelector(".xterm-viewport") as HTMLElement;
      const intents: number[] = [];
      const observer = w.observeIntent(term, viewport, () => true, (lines: number) => intents.push(lines));
      const write = (data: string) => new Promise<void>(resolve => term.write(data, resolve));
      const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}\r\n`).join("");
      await write(lines(2000));
      await new Promise(r => setTimeout(r, 100));
      // A replay shrinks scrollback. Its render clamps DOM scrollTop to the
      // new bottom without setting xterm's "ignore next scroll" flag. Live
      // output parses in the same task before that native scroll is delivered.
      await new Promise<void>(resolve => term.write("\x1bc" + lines(1024), () => {
        observer.programmatic(() => term.scrollToBottom());
        term._core.viewport.syncScrollArea(true);
        term.write("LIVE one\r\nLIVE two\r\nLIVE three\r\nLIVE four\r\n", resolve);
      }));
      await new Promise(r => setTimeout(r, 100));
      const afterReplay = term.buffer.active.baseY - term.buffer.active.viewportY;
      await write("TAIL latest\r\n");
      await new Promise(r => setTimeout(r, 100));
      const afterOutput = term.buffer.active.baseY - term.buffer.active.viewportY;
      const programmaticIntents = [...intents];
      const rowHeight = viewport.scrollHeight / (term.buffer.active.baseY + term.rows);
      viewport.scrollTop -= 60 * rowHeight;
      await new Promise(r => setTimeout(r, 100));
      const afterUserScroll = term.buffer.active.baseY - term.buffer.active.viewportY;
      await write("TAIL while reading history\r\n");
      await new Promise(r => setTimeout(r, 100));
      const afterScrolledOutput = term.buffer.active.baseY - term.buffer.active.viewportY;
      viewport.scrollTop = viewport.scrollHeight;
      await new Promise(r => setTimeout(r, 100));
      await write("TAIL back at bottom\r\n");
      await new Promise(r => setTimeout(r, 100));
      const afterUserBottom = term.buffer.active.baseY - term.buffer.active.viewportY;
      observer.dispose(); term.dispose();
      return { afterReplay, afterOutput, programmaticIntents, afterUserScroll, afterScrolledOutput, afterUserBottom };
    });
    expect(result.afterReplay).toBe(0);
    expect(result.afterOutput).toBe(0);
    expect(result.programmaticIntents).toEqual([]);
    expect(result.afterUserScroll).toBe(60);
    expect(result.afterScrolledOutput).toBe(61);
    expect(result.afterUserBottom).toBe(0);
  });
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
