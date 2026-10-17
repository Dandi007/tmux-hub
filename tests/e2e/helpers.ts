import type { Page } from "@playwright/test";

export async function bindSecret(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const r = await fetch("/system/auth-check", { credentials: "include" });
    if (!r.ok) throw new Error("/system/auth-check returned " + r.status);
    const body = (await r.json()) as { secret: string };
    sessionStorage.setItem("hub.secret", body.secret);
  });
}

/**
 * Create a session the way a real user does — through the hub's managed
 * launch path (`POST /templates/:id/run`) on the hub at `baseUrl`. Returns the
 * server-assigned session name (`<templateId>-<ts14>`).
 */
export function makeCreateSession(baseUrl: string): (templateId?: string) => Promise<string> {
  let secret: string | null = null;
  const getSecret = async (): Promise<string> => {
    if (secret) return secret;
    const r = await fetch(`${baseUrl}/system/auth-check`);
    if (!r.ok) throw new Error(`/system/auth-check returned ${r.status}`);
    const body = (await r.json()) as { secret?: string };
    if (!body.secret) throw new Error("/system/auth-check did not return a secret (dev-bind off?)");
    secret = body.secret;
    return secret;
  };

  const createSession = async (templateId = "shell"): Promise<string> => {
    const s = await getSecret();
    const url = `${baseUrl}/templates/${encodeURIComponent(templateId)}/run`;
    // The managed name is `<id>-<ts14>` at second resolution, so two creates
    // landing in the same wall-clock second collide (409). Retry past the
    // second boundary instead of forcing callers to space their fixtures.
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-secret": s },
        body: JSON.stringify({ cwd: "~" }),
      });
      if (r.status === 201) {
        const body = (await r.json()) as { name?: string };
        if (!body.name) throw new Error(`createSession(${templateId}): 201 without name`);
        return body.name;
      }
      if (r.status === 409) {
        await new Promise((res) => setTimeout(res, 1100));
        continue;
      }
      const text = await r.text().catch(() => "");
      throw new Error(`createSession(${templateId}) failed: HTTP ${r.status} ${text}`);
    }
    throw new Error(`createSession(${templateId}) failed: name kept colliding (409)`);
  };
  return createSession;
}
