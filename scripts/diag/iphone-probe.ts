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

const switchTarget = options.filter((o) => !o.disabled && o.value !== initialValue)[0];
if (switchTarget) {
  console.log("[probe] switching to:", switchTarget.value);
  const beforeXtermCount = await page.$$eval(".mobile-shell__term-host .xterm", (els) => els.length);
  await page.selectOption(".mobile-shell__session-select", switchTarget.value);

  // Sample DOM state every 500ms for 6s to see whether the new xterm ever
  // mounts and what's in termHost meanwhile.
  for (let i = 1; i <= 12; i++) {
    await page.waitForTimeout(500);
    const sample = await page.evaluate(() => {
      const host = document.querySelector(".mobile-shell__term-host") as HTMLElement | null;
      return {
        xtermCount: document.querySelectorAll(".mobile-shell__term-host .xterm").length,
        terminalHostCount: document.querySelectorAll(".mobile-shell__term-host .terminal-host").length,
        hostChildren: host ? Array.from(host.children).map((c) => c.className) : null,
        hostHeight: host?.getBoundingClientRect().height ?? null,
      };
    });
    console.log(`[probe] t+${(i*500).toString().padStart(4)}ms`, sample);
  }
  const afterSelection = await page.$eval(".mobile-shell__session-select", (e) => (e as HTMLSelectElement).value);
  console.log(`[probe] xterm count before=${beforeXtermCount}, selection=${afterSelection}`);
  await page.screenshot({ path: "test-results/iphone-2-after-switch.png", fullPage: false });
}

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
