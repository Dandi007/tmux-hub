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
import { writeFileSync } from "node:fs";
import type { Page, TestType, Expect } from "@playwright/test";
import { bindSecret } from "./helpers";

type Ctx = {
  tmuxE2E: (args: string[]) => string;
  createSession: (templateId?: string) => Promise<string>;
};

type Probe = { state: string; cols: number; rows: number; screen: () => string[] };

declare global {
  interface Window { __tmuxHubTerms?: Record<string, Probe> }
}

function normalize(lines: string[]): string[] {
  const out = lines.map((l) => l.replace(/\s+$/, ""));
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

async function browserView(page: Page, name: string): Promise<{ size: string; lines: string[]; state: string } | null> {
  return page.evaluate((n) => {
    const p = window.__tmuxHubTerms?.[n];
    if (!p) return null;
    return { size: `${p.cols}x${p.rows}`, lines: p.screen(), state: p.state };
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

export function defineFidelitySuite(test: TestType<{ ctx: Ctx }, object>, expect: Expect): void {
  async function expectInSync(page: Page, ctx: Ctx, name: string, why: string): Promise<void> {
    let last = "";
    await expect.poll(async () => {
      const b = await browserView(page, name);
      const t = tmuxView(ctx, name);
      if (!b) { last = "probe missing"; return false; }
      const bl = normalize(b.lines);
      const tl = normalize(t.lines);
      const same = b.state === "connected" && b.size === t.size && JSON.stringify(bl) === JSON.stringify(tl);
      if (!same) {
        const diff: string[] = [];
        for (let i = 0; i < Math.max(bl.length, tl.length); i++) {
          if (bl[i] !== tl[i]) diff.push(`  row ${i}\n    tmux:  ${JSON.stringify(tl[i])}\n    xterm: ${JSON.stringify(bl[i])}`);
        }
        last = `state=${b.state} size xterm=${b.size} tmux=${t.size}\n${[...diff.slice(0, 3), "  ...", ...diff.slice(-5)].join("\n")}`;
      }
      return same;
    }, { message: `xterm screen != tmux capture-pane (${why})`, timeout: 10_000, intervals: [100, 250, 500] })
      .toBe(true)
      .catch((e: Error) => { throw new Error(`${e.message}\n${last}`); });
  }

  async function openSession(page: Page, name: string): Promise<void> {
    await page.goto("/?debug=term");
    await bindSecret(page);
    await page.reload();
    await page.evaluate((n) => window.__tmuxHub?.openSession?.(n), name);
    await expect.poll(() => browserView(page, name).then((b) => b?.state), { timeout: 10_000 }).toBe("connected");
  }

  async function runAndWait(ctx: Ctx, name: string, cmd: string, marker: string): Promise<void> {
    ctx.tmuxE2E(["send-keys", "-t", name, cmd, "Enter"]);
    await expect.poll(() => ctx.tmuxE2E(["capture-pane", "-p", "-t", name]), { timeout: 10_000 }).toContain(marker);
  }

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
      await page.evaluate((n) => (window.__tmuxHubTerms![n] as unknown as { dropSocket: () => void }).dropSocket(), name);
      await runAndWait(ctx, name, `sh ${writeGenerator("gap", 50)}`, "gap 050");
      await expectInSync(page, ctx, name, "after reconnect");

      // Full page reload = fresh attach of an already-busy session.
      await page.reload();
      await page.evaluate((n) => window.__tmuxHub?.openSession?.(n), name);
      await expectInSync(page, ctx, name, "after reload");
    });

    // KNOWN BUG（backlog P1「resize 后屏幕错位」）：约 1/6 概率，resize 后再输出时
    // xterm 比 tmux 多出一行（zsh PROMPT_SP 的 "%" 行），此后整屏错一行且不自愈。
    // 推测 xterm.js 与 tmux 对软换行空格行的 reflow 不一致，光标行分叉。修复后去掉 fixme。
    test.fixme("resize: xterm screen == capture-pane after the pane follows the browser", async ({ page, ctx }) => {
      const name = await ctx.createSession();
      await runAndWait(ctx, name, `clear; sh ${writeGenerator("wide", 80)}`, "wide 080");
      await openSession(page, name);
      await expectInSync(page, ctx, name, "before resize");
      await page.setViewportSize({ width: 900, height: 600 });
      await expectInSync(page, ctx, name, "after resize");
      await runAndWait(ctx, name, `sh ${writeGenerator("narrow", 30)}`, "narrow 030");
      await expectInSync(page, ctx, name, "output after resize");
    });

    test("alt-screen (vim) at a stable size survives reconnect", async ({ page, ctx }) => {
      const name = await ctx.createSession();
      const file = writeVimSource();
      // Idle shell first: attaching while zsh is still drawing its first prompt
      // hits the attach-resize race tracked by the fixme below.
      await runAndWait(ctx, name, "clear; echo shell-ready", "shell-ready");
      await openSession(page, name);
      await expectInSync(page, ctx, name, "shell before vim");
      await runAndWait(ctx, name, `vim -u NONE -n ${file}`, "vim 行 1 ");
      await expectInSync(page, ctx, name, "vim started while attached");
      ctx.tmuxE2E(["send-keys", "-t", name, "20G", ""]);
      await page.evaluate((n) => (window.__tmuxHubTerms![n] as unknown as { dropSocket: () => void }).dropSocket(), name);
      ctx.tmuxE2E(["send-keys", "-t", name, "Gdd", ""]);
      await expectInSync(page, ctx, name, "vim after reconnect");
      ctx.tmuxE2E(["send-keys", "-t", name, ":q!", "Enter"]);
    });

    // KNOWN BUG（backlog P1「attach 时运行中的 TUI 被 resize 后错位」）：vim 约 1/25，
    // 刚起的 zsh 更高（prompt 被画多次）。
    // vim 在默认 200x50 下运行，浏览器 attach 把 pane 钉到自身尺寸，vim 随之重绘；
    // xterm 整屏错位（顶行显示第 18 行、底部空白），且不会自愈。修复后去掉 fixme。
    test.fixme("alt-screen (vim) attach that resizes a running TUI", async ({ page, ctx }) => {
      const name = await ctx.createSession();
      const file = writeVimSource();
      await runAndWait(ctx, name, `vim -u NONE -n ${file}`, "vim 行 1 ");
      await openSession(page, name);
      await expectInSync(page, ctx, name, "vim attach");
      ctx.tmuxE2E(["send-keys", "-t", name, ":q!", "Enter"]);
    });
  });
}
