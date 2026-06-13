import type { Page } from "@playwright/test";

export async function bindSecret(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const r = await fetch("/system/auth-check", { credentials: "include" });
    if (!r.ok) throw new Error("/system/auth-check returned " + r.status);
    const body = (await r.json()) as { secret: string };
    sessionStorage.setItem("hub.secret", body.secret);
  });
}
