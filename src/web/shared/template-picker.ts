// 「新建会话」模板选择器：列出 server 全部模板,点选即启动。
// overlay/panel 单例模式，移动端底部 sheet / 桌面端居中弹窗共用。
import { hubFetch } from "../hub-fetch";
import { showToast } from "../ui/toast";
import { runQuickLaunch } from "./quick-launch";

type TemplateListItem = { id: string; name: string; cwd_choices: string[] };

export function openTemplatePicker(opts: { onStarted: (name: string) => void }): void {
  // 单例：已开则不重复。
  if (document.getElementById("template-picker-overlay")) return;

  const overlay = document.createElement("div");
  overlay.id = "template-picker-overlay";
  overlay.className = "template-picker";

  const panel = document.createElement("div");
  panel.className = "template-picker__panel";
  overlay.appendChild(panel);

  const head = document.createElement("div");
  head.className = "template-picker__head";
  const title = document.createElement("span");
  title.textContent = "新建会话";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "template-picker__close";
  closeBtn.setAttribute("aria-label", "关闭");
  closeBtn.textContent = "✕";
  head.append(title, closeBtn);
  panel.appendChild(head);

  const list = document.createElement("div");
  list.className = "template-picker__list";
  list.textContent = "加载中…";
  panel.appendChild(list);

  const close = (): void => { overlay.remove(); };
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  document.body.appendChild(overlay);

  void loadTemplates(list, opts.onStarted, close);
}

async function loadTemplates(
  list: HTMLElement,
  onStarted: (name: string) => void,
  close: () => void,
): Promise<void> {
  let templates: TemplateListItem[];
  try {
    const res = await hubFetch("/templates");
    if (!res.ok) { list.textContent = `加载失败（${res.status}）`; return; }
    templates = (await res.json()) as TemplateListItem[];
  } catch {
    list.textContent = "加载失败，请重试";
    return;
  }

  list.replaceChildren();
  if (!templates.length) {
    list.textContent = "未配置模板，见 ~/.config/tmux-hub/templates.yaml";
    return;
  }

  for (const t of templates) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "template-picker__item";
    row.textContent = t.name;
    const cwd = t.cwd_choices[0] ?? "~";
    row.addEventListener("click", () => {
      row.disabled = true;
      void runQuickLaunch({
        fetcher: hubFetch,
        templateId: t.id,
        cwd,
        onStarted: (name) => { close(); onStarted(name); },
        onError: (_kind, message) => {
          row.disabled = false;
          showToast(`启动失败：${message}`, "error");
        },
      });
    });
    list.appendChild(row);
  }
}

/**
 * 移动端工具栏的「+」按钮。点击打开模板选择器 sheet。
 */
export function renderQuickLaunchButton(opts: {
  parent: HTMLElement;
  onStarted: (name: string) => void;
}): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "header-action";
  btn.textContent = "+";
  btn.setAttribute("aria-label", "新建会话");
  btn.title = "新建会话";
  opts.parent.appendChild(btn);
  btn.addEventListener("click", () => openTemplatePicker({ onStarted: opts.onStarted }));
  return btn;
}
