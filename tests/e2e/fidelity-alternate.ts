import { stopOwnedGenerator } from "../helpers/stop-owned-generator";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import type { Page, TestType, Expect, PlaywrightTestArgs, PlaywrightWorkerArgs } from "@playwright/test";

type Ctx = { tmuxE2E(args: string[]): string; createSession(templateId?: string): Promise<string> };

export function defineAlternateTests(
  test: TestType<PlaywrightTestArgs & { ctx: Ctx }, PlaywrightWorkerArgs>, expect: Expect,
  openSession: (page: Page, name: string) => Promise<void>,
  expectInSync: (page: Page, ctx: Ctx, name: string, why: string) => Promise<void>,
): void {
  for (const weak of [false, true]) for (const entry of ["offline-entry", "fresh-attach", "continuous-exit"]) {
    test(`ordinary alternate snapshot preserves screens through wheel, resize and exit: ${entry} ${weak ? "weak" : "normal"}`, async ({ page, ctx }, info) => {
      test.setTimeout(60_000);
      const name = await ctx.createSession();
      const owned = mkdtempSync("/tmp/e2e-alt-exit-");
      let continuousStarted = false;
      const wheelSamples: unknown[] = [];
      try {
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
        const sample = () => page.evaluate(n => {
          const p = window.__tmuxHubTerms![n]!;
          const v = document.querySelector<HTMLElement>(".term-slot:not([style*='hidden']) .xterm-viewport") ?? document.querySelector<HTMLElement>(".xterm-viewport");
          return { replays: p.replays, resyncs: p.resyncs, scroll: p.linesFromBottom,
            dom: v ? { top: v.scrollTop, height: v.scrollHeight, client: v.clientHeight } : null };
        }, name);
        const before = await sample();
        await page.mouse.move(box.x + 50, box.y + 50); await page.mouse.wheel(0, -420);
        await page.waitForTimeout(250);
        wheelSamples.push({ before, after: await sample() });
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
      const exitCommand = entry === "continuous-exit"
        ? `printf '\\033[?1049lNORMAL_ORDINARY\\n'; i=0; while [ ! -f ${owned}/stop ]; do printf '\\033[1;1HTICK'; i=$((i+1)); printf '%s' "$i" > ${owned}/progress; sleep 0.05; done; printf '\\r\\n\\033[2KCONTINUOUS_DONE\\r\\n'; : > ${owned}/done`
        : "printf '\\033[?1049lNORMAL_ORDINARY\\n'";
      ctx.tmuxE2E(["send-keys", "-t", name, exitCommand, "Enter"]);
      continuousStarted = entry === "continuous-exit";
      await expect.poll(serverAlt).toBe("0");
      if (entry === "continuous-exit") await expect.poll(() =>
        existsSync(`${owned}/progress`) ? Number(readFileSync(`${owned}/progress`, "utf8")) : 0).toBeGreaterThan(4);
      const ticking = entry === "continuous-exit" ? Number(readFileSync(`${owned}/progress`, "utf8")) : 0;
      await expectInSync(page, ctx, name, "live exit restores normal screen");
      if (entry === "continuous-exit") {
        expect(existsSync(`${owned}/stop`)).toBe(false);
        await expect.poll(() => Number(readFileSync(`${owned}/progress`, "utf8"))).toBeGreaterThan(ticking);
        writeFileSync(`${owned}/stop`, "stop");
        await expect.poll(() => ctx.tmuxE2E(["capture-pane", "-p", "-t", name]).split("\n").includes("CONTINUOUS_DONE")).toBe(true);
        await expectInSync(page, ctx, name, "normal after continuous output stops");
      }
      // Text can match while the final repair is still parsing. Start this
      // normal-history navigation after all announced snapshots complete;
      // navigation during replay has its own fidelity-scroll-intent cases.
      await expect.poll(() => page.evaluate(n => {
        const p = window.__tmuxHubTerms![n]!; return p.replays - p.resyncs;
      }, name)).toBe(1);
      await wheel(); expect((await view()).scroll).toBeGreaterThan(0);
      const chosen = (await view()).scroll, replay = (await view()).replays;
      await page.evaluate(n => window.__tmuxHubTerms![n]!.dropSocket(), name);
      await expect.poll(async () => (await view()).replays).toBeGreaterThan(replay);
      await expect.poll(async () => (await view()).scroll).toBe(chosen);
      await expectInSync(page, ctx, name, "normal history still navigates and reconnects");
      if (weak) expect(delayed).toBeGreaterThan(0);
      } catch (error) {
        writeFileSync(info.outputPath("alternate-failure.json"), JSON.stringify({ wheelSamples,
          probe: await page.evaluate(n => { const p = window.__tmuxHubTerms?.[n]; return p ? { state: p.state, scroll: p.linesFromBottom, replays: p.replays, resyncs: p.resyncs, lines: p.screen() } : null; }, name).catch(() => null),
          pane: ctx.tmuxE2E(["capture-pane", "-p", "-t", name]),
          modes: ctx.tmuxE2E(["display", "-p", "-t", name, "#{alternate_on} #{history_size} #{mouse_standard_flag} #{mouse_sgr_flag}"]),
        }));
        await page.screenshot({ path: info.outputPath("alternate-failure.png") }).catch(() => {});
        throw error;
      } finally {
        if (continuousStarted) {
          const cleanup = await stopOwnedGenerator(owned, name, {
            listSessions: () => ctx.tmuxE2E(["list-sessions", "-F", "#{session_name}"]).split("\n"),
            killSession: n => { ctx.tmuxE2E(["kill-session", "-t", n]); },
          });
          writeFileSync(info.outputPath("generator-cleanup.json"), JSON.stringify(cleanup));
        } else rmSync(owned, { recursive: true, force: true });
      }
    });
  }
  for (const replay of [false, true]) test(`alternate exit preserves platform input: ${replay ? "snapshot repair" : "no snapshot"}`, async ({ page, ctx }, info) => {
    test.setTimeout(60_000);
    const owned = mkdtempSync("/tmp/e2e-alt-input-");
    const received = `${owned}/received`, app = `${owned}/app.sh`;
    const priorModes = replay ? "\x1b[?1006h" : "";
    const exitModes = replay
      ? "\x1bc\x1b[3;8r\x1b[?6h\x1b[?7l\x1b[?1;2004;1000h\x1b[!p"
      : "\x1b[?1;2004;1000;1006h\x1b[!p";
    let name = "";
    writeFileSync(app, `stty -echo -icanon min 1 time 0
set -- $(stty size); cols=$2
printf '${priorModes}\x1b[?1049h\x1b[HALT_INPUT'
dd bs=1 count=1 of=/dev/null 2>/dev/null
printf '\x1b[?1049l${exitModes}INPUT_READY'
${replay ? `while [ ! -f ${owned}/continue ]; do sleep 0.01; done; printf 'x\x1b[1;%sHAB' "$cols"` : ""}
dd bs=1 of=${received} 2>/dev/null
`);
    try {
      name = await ctx.createSession();
      await openSession(page, name); await expectInSync(page, ctx, name, "input fixture ready");
      await page.waitForTimeout(400); // Finish initial layout before the no-replay control.
      ctx.tmuxE2E(["send-keys", "-t", name, `sh ${app}`, "Enter"]);
      await expect.poll(() => ctx.tmuxE2E(["display", "-p", "-t", name, "#{alternate_on}"])).toBe("1");
      await expectInSync(page, ctx, name, "input app alternate");
      if (replay) {
        await page.reload();
        await expectInSync(page, ctx, name, "actual alternate snapshot before exit");
      }
      const before = await page.evaluate(n => { const p = window.__tmuxHubTerms![n]!; return { resyncs: p.resyncs, replays: p.replays }; }, name);
      ctx.tmuxE2E(["send-keys", "-t", name, "Enter"]);
      await expect.poll(() => ctx.tmuxE2E(["capture-pane", "-p", "-t", name])).toContain("INPUT_READY");
      if (replay) {
        await expect.poll(() => page.evaluate(n => window.__tmuxHubTerms![n]!.resyncs, name)).toBeGreaterThan(before.resyncs);
        await expect.poll(() => page.evaluate(n => window.__tmuxHubTerms![n]!.replays, name)).toBeGreaterThan(before.replays);
      } else {
        await page.waitForTimeout(350);
        expect(await page.evaluate(n => window.__tmuxHubTerms![n]!.resyncs, name)).toBe(before.resyncs);
      }
      await expectInSync(page, ctx, name, "input modes after actual repair");
      if (replay) {
        writeFileSync(`${owned}/continue`, "go");
        await expect.poll(() => ctx.tmuxE2E(["capture-pane", "-p", "-t", name])).toContain("INPUT_READYx");
        await expectInSync(page, ctx, name, "origin and no-wrap survive real repair and later right-edge output");
      }
      const bytes = () => existsSync(received) ? readFileSync(received, "utf8") : "";
      if (info.project.use.isMobile) {
        // Mobile intentionally opens xterm readOnly:true. Exercise its real
        // toolbar and text composer; desktop raw keyboard/mouse isn't its UI.
        await page.locator(".input-bar__keys").click();
        await page.locator(".toolbar-keys .tk-up").click();
        await expect.poll(bytes).toContain("\x1bOA");
        const ta = page.locator(".input-bar__textarea");
        await ta.click(); await ta.fill("PASTE_CHECK");
        await page.locator(".input-bar__send").click();
        await expect.poll(bytes).toContain("PASTE_CHECK\n");
        const beforeMouse = bytes();
        const box = await page.locator(".xterm-screen:visible").first().boundingBox();
        if (!box) throw new Error("missing readonly terminal");
        await page.mouse.click(box.x + 50, box.y + 50); await page.waitForTimeout(100);
        expect(bytes()).toBe(beforeMouse);
      } else {
        await page.locator(".xterm:visible .xterm-helper-textarea").focus();
        await page.keyboard.press("ArrowUp");
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
        await page.evaluate(() => navigator.clipboard.writeText("PASTE_CHECK"));
        await page.keyboard.press("Control+Shift+V");
        const box = await page.locator(".xterm-screen:visible").first().boundingBox();
        if (!box) throw new Error("missing input terminal");
        const mouseX = box.x + (replay ? box.width - 50 : 50), mouseY = box.y + 50;
        const grid = await page.evaluate(n => { const p = window.__tmuxHubTerms![n]!; return { cols: p.cols, rows: p.rows }; }, name);
        await page.mouse.click(mouseX, mouseY);
        await expect.poll(bytes).toContain("\x1bOA");
        await expect.poll(bytes).toContain("\x1b[200~PASTE_CHECK\x1b[201~");
        if (replay) {
          const expected = Buffer.from([27, 91, 77, 32,
            33 + Math.floor((mouseX - box.x) * grid.cols / box.width),
            33 + Math.floor((mouseY - box.y) * grid.rows / box.height)]);
          expect(expected[4]).toBeGreaterThan(127); // Actual high-coordinate byte, not UTF8.
          await expect.poll(() => existsSync(received) && readFileSync(received).includes(expected)).toBe(true);
          expect(bytes()).not.toContain("\x1b[<");
        } else await expect.poll(bytes).toMatch(/\x1b\[<0;\d+;\d+M/);
      }
    } catch (error) {
      if (name) {
        const probe = await page.evaluate(n => { const p = window.__tmuxHubTerms?.[n]; return p ? { state: p.state, cols: p.cols, rows: p.rows, scroll: p.linesFromBottom, lines: p.screen() } : null; }, name).catch(() => null);
        writeFileSync(info.outputPath("platform-failure.json"), JSON.stringify({ probe,
          pane: ctx.tmuxE2E(["capture-pane", "-p", "-t", name]),
          modes: ctx.tmuxE2E(["display", "-p", "-t", name, "#{alternate_on} #{origin_flag} #{wrap_flag} #{mouse_sgr_flag}"]),
        }));
        await page.screenshot({ path: info.outputPath("platform-failure.png") }).catch(() => {});
      }
      throw error;
    } finally {
      if (existsSync(received)) writeFileSync(info.outputPath("application-input.hex"), readFileSync(received).toString("hex"));
      rmSync(owned, { recursive: true, force: true });
    }
  });

}
