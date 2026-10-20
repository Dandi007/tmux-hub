import { defineAlternateTests } from "./fidelity-alternate";
import { defineForegroundCleanupTests } from "./foreground-cleanup";
// TUI 回传保真 oracle：浏览器里 xterm 实际持有的屏幕文本必须与 tmux 的
// `capture-pane -p` 逐行一致——首次 attach、流式输出中、断线重连（断线期间
// 有新输出）、resize、reload、alt-screen（vim）。xterm 用 canvas 渲染、没有
// 文本 DOM，所以通过 `?debug=term` 暴露的只读 probe（src/web/terminal.ts）读取。
//
// 挂在 emulator project 上（TMUX_HUB_EMULATOR=1 的 snapshot 路径，即 prod /
// dogfood 的实际配置）。legacy 原始字节回放路径（flag 关）已知做不到逐行一致：
// 尾部字节重放不含 attach 前已滚出的屏幕状态，首次 attach 只剩 prompt（2026-10-17
// 实测）。它只为秒级回滚而保留，所以不对它跑 oracle。suite 写成函数，以便以后
// 给别的 project 复用。
import { writeFileSync, rmSync } from "node:fs";
import type { Page, TestType, Expect, PlaywrightTestArgs, PlaywrightWorkerArgs } from "@playwright/test";
import type { TerminalProbe } from "../../src/web/terminal";
import { bindSecret } from "./helpers";
import { defineForegroundTests } from "./fidelity-foreground";
import { defineScrollIntentTests } from "./fidelity-scroll-intent";
import { defineReconnectQueueTest } from "./fidelity-reconnect-queue";

type Ctx = {
  tmuxE2E: (args: string[]) => string;
  createSession: (templateId?: string) => Promise<string>;
};

function normalize(lines: string[]): string[] {
  const out = lines.map((l) => l.replace(/\s+$/, ""));
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

async function browserView(page: Page, name: string): Promise<{ size: string; lines: string[]; state: string; visible: boolean; resyncs: number } | null> {
  return page.evaluate((n) => {
    const p = window.__tmuxHubTerms?.[n];
    if (!p) return null;
    return { size: `${p.cols}x${p.rows}`, lines: p.screen(), state: p.state, visible: p.visible, resyncs: p.resyncs };
  }, name);
}

function tmuxView(ctx: Ctx, name: string): { size: string; lines: string[] } {
  const size = ctx.tmuxE2E(["display", "-p", "-t", name, "#{pane_width}x#{pane_height}"]);
  // -p without -e: plain text of the visible screen, which is what translateToString gives.
  const lines = ctx.tmuxE2E(["capture-pane", "-p", "-t", name]).split("\n");
  return { size, lines };
}

/** A self-contained script that prints colored, CJK and box-drawing lines. */
function writeGenerator(tag: string, count: number): string {
  const path = `/tmp/e2e-fidelity-${tag}-${process.pid}.sh`;
  writeFileSync(path,
    `i=1; while [ $i -le ${count} ]; do ` +
    `printf '\\033[3%dm${tag} %03d\\033[0m 中文全角（括号）：标点 ascii-%d │ ─┼─ end\\n' $((i % 7 + 1)) $i $i; ` +
    `i=$((i + 1)); done\n`);
  return path;
}

function writeVimSource(): string {
  const path = `/tmp/e2e-fidelity-vim-${process.pid}-${Date.now()}.txt`;
  writeFileSync(path, Array.from({ length: 40 }, (_, i) => `vim 行 ${i + 1} 中文（全角）：ok`).join("\n") + "\n");
  return path;
}

export function defineFidelitySuite(test: TestType<PlaywrightTestArgs & { ctx: Ctx }, PlaywrightWorkerArgs>, expect: Expect): void {
  async function expectInSync(page: Page, ctx: Ctx, name: string, why: string): Promise<void> {
    let last = "";
    await expect.poll(async () => {
      const b = await browserView(page, name);
      const t = tmuxView(ctx, name);
      if (!b) { last = "probe missing"; return false; }
      const bl = normalize(b.lines);
      const tl = normalize(t.lines);
      const same = b.state === "connected" && b.visible && b.size === t.size && JSON.stringify(bl) === JSON.stringify(tl);
      if (!same) {
        const diff: string[] = [];
        for (let i = 0; i < Math.max(bl.length, tl.length); i++) {
          if (bl[i] !== tl[i]) diff.push(`  row ${i}\n    tmux:  ${JSON.stringify(tl[i])}\n    xterm: ${JSON.stringify(bl[i])}`);
        }
        last = `state=${b.state} visible=${b.visible} resyncs=${b.resyncs} size xterm=${b.size} tmux=${t.size}\n${[...diff.slice(0, 3), "  ...", ...diff.slice(-5)].join("\n")}`;
      }
      return same;
    }, { message: `xterm screen != tmux capture-pane (${why})`, timeout: 10_000, intervals: [100, 250, 500] })
      .toBe(true)
      .catch((e: Error) => { throw new Error(`${e.message}\n${last}`); });
  }

  defineForegroundTests(test, expect, expectInSync);
  defineForegroundCleanupTests(test, expect);

  async function openSession(page: Page, name: string): Promise<void> {
    await page.goto("/?debug=term");
    await bindSecret(page);
    // Both views restore the last-opened session once their list loads; make
    // that our session, so a late restore cannot switch away from it (the
    // mobile view has a single terminal: switching closes our probe).
    await page.evaluate((n) => localStorage.setItem("tmux-hub.last-session", n), name);
    await page.reload();
    // Opening a session the hub has not listed yet gets the ws rejected (410);
    // wait until the list (desktop tab / mobile picker item) shows it.
    await expect(page.locator(`[data-session="${name}"]`).first()).toBeAttached({ timeout: 10_000 });
    // The desktop view can still restore after this call and leave our tab
    // hidden (scroll-restore then defers to activation). Re-open until our
    // slot is the visible one.
    await expect.poll(async () => {
      await page.evaluate((n) => window.__tmuxHub?.openSession?.(n), name);
      return page.evaluate((n) => {
        const p = window.__tmuxHubTerms?.[n];
        return p ? `${p.state}/${p.visible}` : "missing";
      }, name);
    }, { timeout: 10_000 }).toBe("connected/true");
  }

  async function runAndWait(ctx: Ctx, name: string, cmd: string, marker: string): Promise<void> {
    ctx.tmuxE2E(["send-keys", "-t", name, cmd, "Enter"]);
    await expect.poll(() => ctx.tmuxE2E(["capture-pane", "-p", "-t", name]), { timeout: 10_000 }).toContain(marker);
  }

  defineAlternateTests(test, expect, openSession, expectInSync);
  defineReconnectQueueTest(test, expect, openSession, expectInSync);
  defineScrollIntentTests(test, expect, openSession, expectInSync);

  test.describe("TUI 回传保真 oracle", () => {
    test("attach, stream, reconnect, reload: xterm screen == capture-pane", async ({ page, ctx }) => {
      const name = await ctx.createSession();
      // Content that predates the attach: delivered by replay / emulator snapshot.
      await runAndWait(ctx, name, `clear; sh ${writeGenerator("pre", 80)}`, "pre 080");
      await openSession(page, name);
      await expectInSync(page, ctx, name, "initial attach");

      // Live streaming while attached.
      await runAndWait(ctx, name, `sh ${writeGenerator("live", 400)}`, "live 400");
      await expectInSync(page, ctx, name, "after streaming");

      // Output produced while the socket is down must show up after reconnect.
      await page.evaluate((n) => window.__tmuxHubTerms![n]!.dropSocket(), name);
      await runAndWait(ctx, name, `sh ${writeGenerator("gap", 50)}`, "gap 050");
      await expectInSync(page, ctx, name, "after reconnect");

      // Full page reload = fresh attach of an already-busy session.
      await page.reload();
      await page.evaluate((n) => window.__tmuxHub?.openSession?.(n), name);
      await expectInSync(page, ctx, name, "after reload");
    });

    test("a busy reconnect converges after output stops and preserves scroll without reconnecting again", async ({ page, ctx }) => {
      const name = await ctx.createSession();
      await runAndWait(ctx, name, `clear; sh ${writeGenerator("busyhist", 200)}`, "busyhist 200");
      await openSession(page, name);
      await expectInSync(page, ctx, name, "before busy reconnect");
      await page.waitForTimeout(1200); // let initial layout resync finish
      const tag = `/tmp/e2e-busy-${process.pid}-${Date.now()}`;
      const script = tag + ".sh", stop = tag + ".stop";
      writeFileSync(script, `printf '\\033[2J\\033[HHEADER\\nfirst\\nsecond\\nthird\\n'
` +
        `i=0; while [ ! -f '${stop}' ]; do i=$((i+1)); printf '\\033[3A'; sleep 0.008; ` +
        `for row in 0 1 2; do printf '\\r\\033[Kframe %04d row %d\\n' "$i" "$row"; sleep 0.008; done; done
` +
        `while :; do sleep 10; done
`);
      const overlapCount = async () => {
        const text = await (await page.request.get("/metrics")).text();
        return Number(/^tmux_hub_snapshot_overlaps_total (\d+)$/m.exec(text)?.[1] ?? -1);
      };
      try {
        const overlaps = await overlapCount();
        ctx.tmuxE2E(["send-keys", "-t", name, `sh ${script}`, "Enter"]);
        await expect.poll(() => ctx.tmuxE2E(["capture-pane", "-p", "-t", name])).toContain("frame ");
        await page.evaluate((n) => window.__tmuxHubTerms![n]!.scrollLines(-30), name);
        const before = await page.evaluate((n) => {
          const p = window.__tmuxHubTerms![n]!;
          return { replays: p.replays, resyncs: p.resyncs, scroll: p.linesFromBottom };
        }, name);
        expect(before.scroll).toBe(30);
        await page.evaluate((n) => window.__tmuxHubTerms![n]!.dropSocket(), name);
        await expect.poll(overlapCount, { timeout: 10000 }).toBeGreaterThan(overlaps);
        writeFileSync(stop, "stop");
        await expectInSync(page, ctx, name, "automatic recovery after busy reconnect");
        await expect.poll(() => page.evaluate((n) => window.__tmuxHubTerms![n]!.resyncs, name)).toBeGreaterThan(before.resyncs);
        await expect.poll(() => page.evaluate((n) => window.__tmuxHubTerms![n]!.linesFromBottom, name)).toBe(30);
      } finally {
        writeFileSync(stop, "stop");
        ctx.tmuxE2E(["send-keys", "-t", name, "C-c"]);
        rmSync(script, { force: true });
        rmSync(stop, { force: true });
      }
    });

    // Regression（2026-10-19 dogfood）：会话被杀掉、紧接着用同名重建（rsi driver
    // 跨天换会话就是这样），registry 按名字 diff 看不出变化，broadcaster 仍挂在旧
    // pane 上，新 pane 没有 pipe-pane：浏览器拿到 snapshot 后画面冻住。
    test("a session recreated under the same name keeps streaming to the page", async ({ page, ctx }) => {
      const name = await ctx.createSession();
      await runAndWait(ctx, name, `clear; sh ${writeGenerator("before", 20)}`, "before 020");
      await openSession(page, name);
      await expectInSync(page, ctx, name, "before recreate");

      ctx.tmuxE2E(["kill-session", "-t", name]);
      ctx.tmuxE2E(["new-session", "-d", "-s", name, "-x", "120", "-y", "40"]);
      await runAndWait(ctx, name, `clear; sh ${writeGenerator("after", 20)}`, "after 020");
      // The list drops and re-adds the session; the page reopens it by itself.
      await expectInSync(page, ctx, name, "after recreate");
    });

    // Regression（第 5 轮修复）：resize 后 xterm 与 tmux 各自 reflow，光标行分叉
    // （约 1/10），之后的输出整屏错一行，不会自愈。服务端在 resize 生效后重发对齐
    // snapshot（resync）。
    test("resize: xterm screen == capture-pane after the pane follows the browser", async ({ page, ctx }) => {
      const name = await ctx.createSession();
      await runAndWait(ctx, name, `clear; sh ${writeGenerator("wide", 80)}`, "wide 080");
      await openSession(page, name);
      await expectInSync(page, ctx, name, "before resize");
      await page.setViewportSize({ width: 900, height: 600 });
      await expectInSync(page, ctx, name, "after resize");
      await runAndWait(ctx, name, `sh ${writeGenerator("narrow", 30)}`, "narrow 030");
      await expectInSync(page, ctx, name, "output after resize");
    });

    // resync 以 RIS 开头，会清空 buffer；client 必须像 reconnect 一样保住用户的
    // 滚动位置，不能跳回底部或顶部。
    test("resize resync keeps a scrolled-up viewport scrolled up", async ({ page, ctx }) => {
      const name = await ctx.createSession();
      await runAndWait(ctx, name, `clear; sh ${writeGenerator("hist", 200)}`, "hist 200");
      await openSession(page, name);
      await expectInSync(page, ctx, name, "before scroll");
      const resyncs = () => page.evaluate((k) => window.__tmuxHubTerms![k]!.resyncs, name);
      // Layout settling right after attach can send one more resize (and so a
      // resync whose restore would undo a scroll made before it lands): wait
      // until the count has been stable for a second.
      let prev = -1;
      await expect.poll(async () => { const n = await resyncs(); const stable = n === prev; prev = n; return stable; }, { timeout: 10_000, intervals: [1000] }).toBe(true);
      await page.evaluate((n) => window.__tmuxHubTerms![n]!.scrollLines(-60), name);
      const lfb = (n: string) => page.evaluate((k) => window.__tmuxHubTerms![k]!.linesFromBottom, n);
      expect(await lfb(name)).toBe(60);
      const before = await resyncs();
      await page.setViewportSize({ width: 900, height: 600 });
      await expect.poll(resyncs, { timeout: 10_000 }).toBeGreaterThan(before);
      await expectInSync(page, ctx, name, "after resize resync");
      await expect.poll(() => lfb(name), { timeout: 5_000 }).toBe(60);
    });

    test("alt-screen (vim) at a stable size survives reconnect", async ({ page, ctx }) => {
      const name = await ctx.createSession();
      const file = writeVimSource();
      // Idle shell first so this test isolates reconnect, not attach-resize
      // (covered by the two attach tests below).
      await runAndWait(ctx, name, "clear; echo shell-ready", "shell-ready");
      await openSession(page, name);
      await expectInSync(page, ctx, name, "shell before vim");
      await runAndWait(ctx, name, `vim -u NONE -n --cmd "set shortmess+=F" ${file}`, "vim 行 1 ");
      await expectInSync(page, ctx, name, "vim started while attached");
      ctx.tmuxE2E(["send-keys", "-t", name, "20G", ""]);
      await page.evaluate((n) => window.__tmuxHubTerms![n]!.dropSocket(), name);
      ctx.tmuxE2E(["send-keys", "-t", name, "Gdd", ""]);
      await expectInSync(page, ctx, name, "vim after reconnect");
      ctx.tmuxE2E(["send-keys", "-t", name, ":q!", "Enter"]);
    });

    // scroll-restore 的 reconnect 路径（INV-1/INV-3）：断线前向上翻着的，重连
    // 后回到同一位置；断线前跟底的，重连后仍跟底，并看到断线期间的新输出。
    test("reconnect restores a scrolled-up viewport and keeps a bottom one at the bottom", async ({ page, ctx }) => {
      const name = await ctx.createSession();
      await runAndWait(ctx, name, `clear; sh ${writeGenerator("rhist", 200)}`, "rhist 200");
      await openSession(page, name);
      await expectInSync(page, ctx, name, "before scroll");
      const probe = <T,>(k: string) => page.evaluate(([n, key]) => (window.__tmuxHubTerms![n] as unknown as Record<string, unknown>)[key], [name, k] as const) as Promise<T>;
      // Wait out the layout-settle resize after attach (see the resize resync test).
      let prev = -1;
      await expect.poll(async () => { const n = await probe<number>("resyncs"); const stable = n === prev; prev = n; return stable; }, { timeout: 10_000, intervals: [1000] }).toBe(true);

      // "connected" flips on ws open, before the replay and its scroll restore
      // land; wait for the replay itself, or a scroll made in between is
      // (by design, INV-4) overwritten by the pending restore.
      const reconnect = async (): Promise<void> => {
        const before = await probe<number>("replays");
        await page.evaluate((n) => window.__tmuxHubTerms![n]!.dropSocket(), name);
        await expect.poll(() => probe<number>("replays"), { timeout: 10_000 }).toBeGreaterThan(before);
      };

      await page.evaluate((n) => window.__tmuxHubTerms![n]!.scrollLines(-60), name);
      expect(await probe<number>("linesFromBottom")).toBe(60);
      await reconnect();
      await expectInSync(page, ctx, name, "after reconnect (scrolled up)");
      await expect.poll(() => probe<number>("linesFromBottom"), { timeout: 5_000 }).toBe(60);

      await page.evaluate((n) => window.__tmuxHubTerms![n]!.scrollLines(60), name);
      expect(await probe<number>("linesFromBottom")).toBe(0);
      await page.evaluate((n) => window.__tmuxHubTerms![n]!.dropSocket(), name);
      await runAndWait(ctx, name, `sh ${writeGenerator("rgap", 20)}`, "rgap 020");
      await expectInSync(page, ctx, name, "after reconnect (at bottom, output while down)");
      await expect.poll(() => probe<number>("linesFromBottom"), { timeout: 5_000 }).toBe(0);
    });

    // 宽字符宽度（第 9 轮）：tmux 与 Claude Code（Ink）按 Unicode 9+ 把 emoji
    // 算作 2 列，xterm.js 默认 Unicode 6 宽度表算作 1 列。应用按绝对列号定位
    // （CHA / CUP，Ink 的局部重绘就是这样）时，xterm 里后面的内容错开一列，
    // 不会自愈（dogfood 上 CC 会话的 ⚡/💬 行实测出现）。
    test("emoji widths match tmux when the app positions by column", async ({ page, ctx }) => {
      const name = await ctx.createSession();
      await runAndWait(ctx, name, "clear; echo shell-ready", "shell-ready");
      await openSession(page, name);
      await expectInSync(page, ctx, name, "before emoji");
      // The live stream must render it right by itself: a resync/replay
      // snapshot landing during the check would repaint the screen from tmux
      // and mask the bug. Let the post-attach layout resize settle first, and
      // require that no snapshot arrived.
      const counters = () => page.evaluate((k) => { const p = window.__tmuxHubTerms![k]!; return `${p.resyncs}/${p.replays}`; }, name);
      let prev = "";
      await expect.poll(async () => { const c = await counters(); const stable = c === prev; prev = c; return stable; }, { timeout: 10_000, intervals: [1000] }).toBe(true);
      // ⚡ (U+26A1) and 💬 (U+1F4AC) then jump to an absolute column: lands right
      // after the glyph only if both sides agree it is 2 columns wide.
      await runAndWait(ctx, name, "printf '\\342\\232\\241\\033[3GA \\360\\237\\222\\254\\033[7GB end-%s\\n' emoji", "end-emoji");
      await expectInSync(page, ctx, name, "after emoji + CHA");
      expect(await counters()).toBe(prev);
    });

    // 两台设备看同一个会话（第 30 轮实测：dogfood 上 diffRows 30–40，且不自愈）：
    // 后打开的设备把 pane 钉成自己的尺寸，先打开的页面 xterm 仍是旧尺寸，tmux
    // 按新尺寸画的字节落在旧网格上，整屏错乱；后来者关掉后 pane 也停在它的尺寸。
    // 期望：被挤占的页面采用 pane 的新尺寸并收到对齐 snapshot（不回发 resize，
    // 避免两端互抢）；钉住尺寸的设备离开后，可见的页面自动收回自己的尺寸。
    test("a second device pinning the pane keeps the first page in sync", async ({ page, ctx, browser }, testInfo) => {
      const name = await ctx.createSession();
      await runAndWait(ctx, name, `clear; sh ${writeGenerator("two", 60)}`, "two 060");
      await openSession(page, name);
      await expectInSync(page, ctx, name, "first device alone");
      const own = (await browserView(page, name))!.size;

      const narrow = (page.viewportSize()?.width ?? 1280) > 800;
      const other = await browser.newContext({
        baseURL: testInfo.project.use.baseURL,
        viewport: narrow ? { width: 412, height: 800 } : { width: 1300, height: 850 },
      });
      const page2 = await other.newPage();
      await openSession(page2, name);
      await expectInSync(page2, ctx, name, "second device");
      expect((await browserView(page2, name))!.size).not.toBe(own);
      await expectInSync(page, ctx, name, "first device after the second pinned the pane");
      await runAndWait(ctx, name, `sh ${writeGenerator("both", 30)}`, "both 030");
      await expectInSync(page, ctx, name, "first device, output while displaced");

      await other.close();
      await expectInSync(page, ctx, name, "first device after the second left");
      expect((await browserView(page, name))!.size).toBe(own);
    });

    test("both devices converge after simultaneous browser resizes", async ({ page, ctx, browser }, testInfo) => {
      const name = await ctx.createSession();
      await runAndWait(ctx, name, `clear; sh ${writeGenerator("race", 80)}`, "race 080");
      await openSession(page, name);
      const other = await browser.newContext({ baseURL: testInfo.project.use.baseURL, viewport: { width: 1300, height: 850 } });
      try {
        const page2 = await other.newPage();
        await openSession(page2, name);
        await expectInSync(page2, ctx, name, "second page before concurrent resize");
        for (let i = 0; i < 4; i++) {
          await Promise.all([
            page.setViewportSize({ width: i % 2 ? 480 : 412, height: i % 2 ? 780 : 800 }),
            page2.setViewportSize({ width: i % 2 ? 1180 : 1300, height: 850 }),
          ]);
          await page.waitForTimeout(650); // allow the resize publishers and aligned snapshot to run
          await expectInSync(page, ctx, name, `first page concurrent resize ${i}`);
          await expectInSync(page2, ctx, name, `second page concurrent resize ${i}`);
        }
      } finally { await other.close(); }
    });

    // Regression（第 4 轮修复）：刚起的 shell 还在画第一个 prompt 时 attach，
    // 同样命中 attach 时 snapshot 与在途字节重叠的问题（prompt 被画多次）。
    test("fresh shell attach while the first prompt is still being drawn", async ({ page, ctx }) => {
      const name = await ctx.createSession();
      await openSession(page, name);
      await expectInSync(page, ctx, name, "fresh shell attach");
    });

    // Regression（第 4 轮修复）：vim 在默认 200x50 下运行，浏览器 attach 把 pane
    // 钉到自身尺寸，vim 随之重绘；重绘字节若在 capture-pane 之后才经 pipe-pane
    // 到达，会被叠加在 snapshot 上重放一次，整屏错位（顶行显示第 18 行）。
    test("alt-screen (vim) attach that resizes a running TUI", async ({ page, ctx }) => {
      const name = await ctx.createSession();
      const file = writeVimSource();
      await runAndWait(ctx, name, `vim -u NONE -n --cmd "set shortmess+=F" ${file}`, "vim 行 1 ");
      await openSession(page, name);
      await expectInSync(page, ctx, name, "vim attach");
      ctx.tmuxE2E(["send-keys", "-t", name, ":q!", "Enter"]);
    });
  });
}
