// Attach/detach soak against a running hub (dogfood by default). Each cycle opens
// a fresh browser context (cold attach of every tab in the desktop pool), and on
// a rotation also switches tabs, reloads and resizes, then closes it. Afterwards:
//   1) lifecycle: /metrics ws / SSE / subscriber counts must return to baseline,
//      fds must not drift, broadcasters must equal sessions (soak-judge.ts);
//   2) fidelity (with --socket): each tab's xterm screen == tmux capture-pane.
// Exit code 1 on any problem. Prints the gauge curve every 10 cycles.
//
//   bun run scripts/diag/soak.ts --cycles 150 --socket hub-dogfood
//   bun run scripts/diag/soak.ts --url http://127.0.0.1:3101 --secret ~/.config/tmux-hub/hub.secret
import { chromium, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { parseMetrics, judgeSoak, type Metrics } from "./soak-judge";

const { values: opt } = parseArgs({
  options: {
    url: { type: "string", default: "http://100.64.0.6:3102" },
    secret: { type: "string", default: "~/.config/tmux-hub/dogfood.secret" },
    cycles: { type: "string", default: "40" },
    socket: { type: "string" },
  },
});
const URL = opt.url!;
const SECRET = readFileSync(opt.secret!.replace(/^~/, homedir()), "utf8").trim();
const CYCLES = Number(opt.cycles);

const metrics = async (): Promise<Metrics> => parseMetrics(await (await fetch(`${URL}/metrics`)).text());
const brief = (m: Metrics) => ({
  rssMB: +((m.process_resident_memory_bytes ?? 0) / 1048576).toFixed(1),
  heapMB: +((m.process_heap_used_bytes ?? 0) / 1048576).toFixed(1),
  fd: m.process_open_fds, ws: m.tmux_hub_ws_connections, sse: m.tmux_hub_sse_clients,
  subs: m.tmux_hub_broadcaster_subscribers, bc: m.tmux_hub_broadcasters,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function openApp(page: Page, path = "/"): Promise<void> {
  await page.addInitScript((s) => sessionStorage.setItem("hub.secret", s), SECRET);
  await page.goto(URL + path);
  await page.waitForSelector(".tab-bar__tab", { timeout: 15_000 });
}

const base = await metrics();
console.log("base", JSON.stringify(brief(base)));
const browser = await chromium.launch({ headless: true });
for (let i = 1; i <= CYCLES; i++) {
  const ctx = await browser.newContext({ viewport: { width: 900 + (i % 5) * 100, height: 700 + (i % 3) * 100 } });
  const page = await ctx.newPage();
  await openApp(page);
  await sleep(800);
  if (i % 2) { await page.keyboard.press("Control+Tab"); await sleep(400); }
  if (i % 3 === 0) { await page.reload(); await sleep(800); }
  if (i % 4 === 0) { await page.setViewportSize({ width: 1300, height: 850 }); await sleep(500); }
  await ctx.close();
  if (i % 10 === 0) { await sleep(1500); console.log(i, JSON.stringify(brief(await metrics()))); }
}

const problems: string[] = [];
if (opt.socket) {
  const norm = (ls: string[]) => { const o = ls.map((l) => l.replace(/\s+$/, "")); while (o.length && o.at(-1) === "") o.pop(); return o; };
  const tmux = (...a: string[]) => Bun.spawnSync(["tmux", "-L", opt.socket!, ...a]).stdout.toString();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await openApp(page, "/?debug=term");
  const names = await page.locator(".tab-bar__tab").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.session ?? ""));
  for (const name of names) {
    let diff = -1;
    for (let t = 0; t < 20 && diff !== 0; t++) {
      await page.evaluate((n) => window.__tmuxHub?.openSession?.(n), name);
      await sleep(500);
      const v = await page.evaluate((n) => {
        const p = window.__tmuxHubTerms?.[n];
        return p && p.state === "connected" && p.visible ? { size: `${p.cols}x${p.rows}`, lines: p.screen() } : null;
      }, name);
      if (!v) continue;
      const size = tmux("display", "-p", "-t", name, "#{pane_width}x#{pane_height}").trim();
      const tl = norm(tmux("capture-pane", "-p", "-t", name).split("\n"));
      const bl = norm(v.lines);
      diff = v.size !== size ? Infinity : tl.reduce((n, l, k) => n + (l !== bl[k] ? 1 : 0), Math.max(0, bl.length - tl.length));
    }
    console.log("fidelity", name, diff === 0 ? "ok" : `diffRows=${diff}`);
    if (diff !== 0) problems.push(`fidelity ${name}: diffRows=${diff}`);
  }
  await ctx.close();
}
await browser.close();
await sleep(3000);
const end = await metrics();
console.log("end", JSON.stringify(brief(end)));
problems.push(...judgeSoak(base, end));
for (const p of problems) console.log("PROBLEM", p);
process.exit(problems.length ? 1 : 0);
