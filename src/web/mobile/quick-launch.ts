import { MOBILE_QUICK_LAUNCH_TEMPLATE_ID } from "@shared/protocol";
import { hubFetch } from "../hub-fetch";
import { showToast } from "../ui/toast";

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
 * 渲染层(template-picker / 按钮)负责解析 templateId + cwd 与并发禁用态。
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

type TemplateListItem = { id: string; name: string; cwd_choices: string[] };

export type QuickLaunchButtonOpts = {
  parent: HTMLElement;
  onStarted: (name: string) => void;
};

/**
 * Mount the mobile toolbar's quick-launch button. mount-time pulls the
 * configured cwd for kb-cc; if absent, the button is permanently disabled.
 */
export function renderQuickLaunchButton(opts: QuickLaunchButtonOpts): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "header-action";
  btn.textContent = "+";
  btn.setAttribute("aria-label", "新建知识库 Claude Code 会话");
  btn.disabled = true;
  btn.title = "加载中…";
  opts.parent.appendChild(btn);

  let cachedCwd: string | null = null;

  void hubFetch("/templates")
    .then((r) => r.ok ? r.json() as Promise<TemplateListItem[]> : Promise.reject(new Error(`HTTP ${r.status}`)))
    .then((list) => {
      const found = list.find((t) => t.id === MOBILE_QUICK_LAUNCH_TEMPLATE_ID);
      if (!found || found.cwd_choices.length === 0) {
        btn.disabled = true;
        btn.title = `未配置快速启动模板（id: ${MOBILE_QUICK_LAUNCH_TEMPLATE_ID}）`;
        return;
      }
      cachedCwd = found.cwd_choices[0] ?? null;
      btn.disabled = false;
      btn.title = `新建会话：${found.name}`;
    })
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      btn.disabled = true;
      btn.title = `模板加载失败：${msg}`;
    });

  btn.addEventListener("click", () => {
    if (btn.disabled || cachedCwd === null) return;
    btn.disabled = true;
    void runQuickLaunch({
      fetcher: hubFetch,
      templateId: MOBILE_QUICK_LAUNCH_TEMPLATE_ID,
      cwd: cachedCwd,
      onStarted: (name) => {
        btn.disabled = false;
        opts.onStarted(name);
      },
      onError: (kind, message) => {
        btn.disabled = false;
        if (kind === "not-configured") {
          showToast(`未配置快速启动模板：在 ~/.config/tmux-hub/templates.yaml 添加 id: ${MOBILE_QUICK_LAUNCH_TEMPLATE_ID}`, "error");
        } else {
          showToast(`启动失败：${message}`, "error");
        }
      },
    });
  });

  return btn;
}
