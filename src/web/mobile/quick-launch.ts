import { MOBILE_QUICK_LAUNCH_TEMPLATE_ID } from "@shared/protocol";

export type QuickLaunchFetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type RunQuickLaunchOpts = {
  fetcher: QuickLaunchFetcher;
  cwd: string;
  onStarted: (name: string) => void;
  onError: (kind: "not-configured" | "runtime", message: string) => void;
};

/**
 * Pure async helper: POST /templates/{kb-cc}/run with the cached cwd.
 *
 * The render layer is responsible for:
 *   - resolving cwd at mount time from GET /templates
 *   - guarding button disabled state during the in-flight POST
 *
 * Splitting the responsibilities like this keeps the network-shape testable
 * without bringing a DOM into bun:test (the repo intentionally does not pull
 * in happy-dom / jsdom — the e2e suite covers the wiring).
 */
export async function runQuickLaunch(opts: RunQuickLaunchOpts): Promise<void> {
  const { fetcher, cwd, onStarted, onError } = opts;
  const path = `/templates/${encodeURIComponent(MOBILE_QUICK_LAUNCH_TEMPLATE_ID)}/run`;
  let res: Response;
  try {
    res = await fetcher(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
  } catch (e) {
    onError("runtime", e instanceof Error ? e.message : String(e));
    return;
  }
  if (res.status === 404) {
    onError("not-configured", `template '${MOBILE_QUICK_LAUNCH_TEMPLATE_ID}' not configured`);
    return;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => `HTTP ${res.status}`);
    onError("runtime", text || `HTTP ${res.status}`);
    return;
  }
  const body = (await res.json().catch(() => null)) as { name?: string } | null;
  if (!body || typeof body.name !== "string") {
    onError("runtime", "malformed response");
    return;
  }
  onStarted(body.name);
}
