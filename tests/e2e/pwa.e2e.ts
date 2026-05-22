import { test, expect } from "./fixtures";

test.describe("PWA Phase 1 smoke", () => {
  test("manifest is served with correct content-type and required fields", async ({ page }) => {
    const r = await page.request.get("/manifest.webmanifest");
    expect(r.status()).toBe(200);
    const ct = r.headers()["content-type"] ?? "";
    expect(ct).toContain("application/manifest+json");
    const cc = r.headers()["cache-control"] ?? "";
    expect(cc).toMatch(/no-store|no-cache/);
    const m = await r.json();
    expect(m.name).toBe("tmux-hub");
    expect(m.start_url).toBe("/?source=pwa");
    expect(m.display).toBe("standalone");
    expect(Array.isArray(m.icons)).toBe(true);
    const sizes = (m.icons as Array<{ sizes: string }>).map((i) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    const maskable = (m.icons as Array<{ purpose?: string; sizes: string }>).find(
      (i) => i.purpose?.includes("maskable") && i.sizes === "512x512",
    );
    expect(maskable).toBeTruthy();
    expect(Array.isArray(m.shortcuts)).toBe(true);
    expect(m.shortcuts.length).toBeGreaterThanOrEqual(2);
  });

  test("service worker is served with SW headers", async ({ page }) => {
    const r = await page.request.get("/sw.js");
    expect(r.status()).toBe(200);
    expect(r.headers()["service-worker-allowed"]).toBe("/");
    expect(r.headers()["cache-control"] ?? "").toMatch(/no-cache/);
    expect(r.headers()["content-type"] ?? "").toContain("javascript");
    const body = await r.text();
    expect(body.length).toBeGreaterThan(1000);
  });

  test("icons and apple-touch-icon are reachable", async ({ page }) => {
    const paths = [
      "/pwa-192.png",
      "/pwa-512.png",
      "/pwa-maskable-192.png",
      "/pwa-maskable-512.png",
      "/apple-touch-icon-180x180.png",
      "/favicon-32.png",
      "/favicon-16.png",
    ];
    for (const path of paths) {
      const r = await page.request.get(path);
      expect.soft(r.status(), `expected 200 for ${path}`).toBe(200);
      expect.soft(r.headers()["content-type"] ?? "", `${path} content-type`).toContain("image/png");
    }
  });

  test("index.html links the manifest and theme-color", async ({ page }) => {
    await page.goto("/");
    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
    expect(manifestHref).toBe("/manifest.webmanifest");
    const themeColor = await page.locator('meta[name="theme-color"]').getAttribute("content");
    expect(themeColor).toBe("#1a1a1f");
    const appleCapable = await page
      .locator('meta[name="apple-mobile-web-app-capable"]')
      .getAttribute("content");
    expect(appleCapable).toBe("yes");
  });

  test("authGate keeps state-changing endpoints behind auth (SW must not cache 401)", async ({ page }) => {
    // Hit a protected endpoint without supplying the local secret. Even after
    // SW registration, the SW must let the request hit the network so the SPA
    // can react to 401 and prompt re-auth.
    await page.goto("/");
    const status = await page.evaluate(async () => {
      const r = await fetch("/sessions/non-existent/kill", { method: "POST" });
      return r.status;
    });
    expect([401, 410, 400]).toContain(status);
  });
});
