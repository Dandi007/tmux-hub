export type QuickLaunchFetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type RunQuickLaunchOpts = {
  fetcher: QuickLaunchFetcher;
  templateId: string;
  cwd: string;
  onStarted: (name: string) => void;
  onError: (kind: "not-configured" | "runtime", message: string) => void;
};

/**
 * Pure async helper: POST /templates/{templateId}/run with the given cwd.
 * 渲染层(template-picker)负责解析 templateId + cwd 与并发禁用态。
 */
export async function runQuickLaunch(opts: RunQuickLaunchOpts): Promise<void> {
  const { fetcher, templateId, cwd, onStarted, onError } = opts;
  const path = `/templates/${encodeURIComponent(templateId)}/run`;
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
    onError("not-configured", `template '${templateId}' not configured`);
    return;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
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
