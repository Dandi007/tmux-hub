// Headed iPhone 14 probe against the live local hub at :3101.
// Run with:  bun run scripts/diag/iphone-probe.ts
//
// Steps:
//   1) Load /, bindSecret (dev mode auto-returns hub.secret) so the SPA can
//      mount and the WS upgrade has the token.
//   2) Reload — mobile shell renders (viewport <720px).
//   3) Verify safe-area-inset CSS applied, manifest link has crossorigin.
//   4) Read sessions from the select; if there are >=2, switch to the second
//      one and confirm xterm DOM (.xterm) appears in the term host.
//   5) Capture screenshots + console errors.
import { chromium, devices } from "@playwright/test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const URL = "http://127.0.0.1:3101";
const SECRET = readFileSync(join(homedir(), ".config/tmux-hub/hub.secret"), "utf8").trim();

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ ...devices["iPhone 14"] });

const page = await ctx.newPage();
const errors: string[] = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") {
    errors.push(`[${m.type()}] ${m.text()}`);
  }
});
page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));

console.log(`[probe] navigating to ${URL} on iPhone 14 viewport`);
await page.goto(URL, { waitUntil: "domcontentloaded" });

await page.evaluate((secret) => {
  sessionStorage.setItem("hub.secret", secret);
}, SECRET);
await page.reload({ waitUntil: "domcontentloaded" });

// Wait for the SPA to mount the mobile shell before probing layout.
await page.waitForSelector(".mobile-shell, .desktop-shell", { timeout: 5000 });
const layout = await page.evaluate(() => ({
  width: window.innerWidth,
  height: window.innerHeight,
  isMobile: matchMedia("(max-width: 720px)").matches,
  shell: document.querySelector(".mobile-shell, .desktop-shell")?.className ?? null,
  manifestLink: document.querySelector('link[rel="manifest"]')?.getAttribute("crossorigin"),
  themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
}));
console.log("[probe] layout:", layout);

await page.waitForSelector(".mobile-shell__session-select", { timeout: 5000 });
await page.waitForFunction(() => document.querySelectorAll(".mobile-shell__session-select option").length > 0, null, { timeout: 5000 });
const options = await page.$$eval(".mobile-shell__session-select option", (els) =>
  els.map((e) => ({
    value: (e as HTMLOptionElement).value,
    text: (e as HTMLOptionElement).text,
    disabled: (e as HTMLOptionElement).disabled,
  })),
);
console.log("[probe] options:", options);
const initialValue = await page.$eval(".mobile-shell__session-select", (e) => (e as HTMLSelectElement).value);
console.log("[probe] initial selection:", initialValue);

await page.screenshot({ path: "test-results/iphone-1-initial.png", fullPage: false });

const firstXterm = await page.waitForSelector(".mobile-shell__term-host .xterm", { timeout: 8000 }).catch(() => null);
console.log("[probe] first xterm mounted:", !!firstXterm);

const switchable = options.filter((o) => !o.disabled);
const sequence: string[] = [];
// Mix slow switches (user reading) and rapid switches (user fumbling).
const cycle = (() => {
  const all = switchable.map((s) => s.value);
  const out: Array<{ name: string; gap: number }> = [];
  for (let round = 0; round < 3; round++) {
    for (const v of all) {
      out.push({ name: v, gap: round === 1 ? 80 : round === 2 ? 250 : 1500 });
    }
  }
  return out;
})();

const failures: Array<{ idx: number; from: string; to: string; xtermAfter: number }> = [];
let prev = initialValue;
let idx = 0;
for (const step of cycle) {
  idx += 1;
  if (step.name === prev) continue;
  await page.selectOption(".mobile-shell__session-select", step.name);
  sequence.push(step.name);
  await page.waitForTimeout(step.gap);
  // Wait up to extra 2s for xterm to mount on this step.
  let mounted = false;
  for (let w = 0; w < 20; w++) {
    const c = await page.$$eval(".mobile-shell__term-host .xterm", (els) => els.length);
    if (c >= 1) { mounted = true; break; }
    await page.waitForTimeout(100);
  }
  const xtermAfter = await page.$$eval(".mobile-shell__term-host .xterm", (els) => els.length);
  const hostChildren = await page.evaluate(() => {
    const h = document.querySelector(".mobile-shell__term-host") as HTMLElement | null;
    return h ? Array.from(h.children).map((c) => c.className) : null;
  });
  const status = mounted ? "OK" : "FAIL";
  console.log(`[probe] step ${idx.toString().padStart(2)} ${prev} → ${step.name} (gap ${step.gap}ms) ${status} xterm=${xtermAfter} host=${JSON.stringify(hostChildren)}`);
  if (!mounted) failures.push({ idx, from: prev, to: step.name, xtermAfter });
  prev = step.name;
}
console.log(`[probe] sequence (${sequence.length} switches):`, sequence.join(" → "));
console.log(`[probe] failures (${failures.length}):`, failures);
await page.screenshot({ path: "test-results/iphone-2-after-switch.png", fullPage: false });

const computed = await page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  const header = document.querySelector(".mobile-shell__header") as HTMLElement | null;
  const select = document.querySelector(".mobile-shell__session-select") as HTMLElement | null;
  return {
    tapMin: cs.getPropertyValue("--tap-min").trim(),
    safeBottom: cs.getPropertyValue("--safe-bottom").trim(),
    headerPosition: header ? getComputedStyle(header).position : null,
    selectMinHeight: select ? getComputedStyle(select).minHeight : null,
  };
});
console.log("[probe] computed:", computed);

console.log(`[probe] errors (${errors.length}):`);
for (const e of errors) console.log("  " + e);

await browser.close();
