// 「新建会话」模板选择器：锚定在触发按钮旁的轻量 dropdown。
// 单例模式：同时只开一个，点外部自动关闭。
import { hubFetch } from "../hub-fetch";
import { showToast } from "../ui/toast";
import { runQuickLaunch } from "./quick-launch";

type TemplateListItem = { id: string; name: string; cwd_choices: string[] };

export function openTemplatePicker(opts: {
  anchor: HTMLElement;
  onStarted: (name: string) => void;
}): void {
  // 单例：已开则关闭旧的。
  const existing = document.getElementById("template-picker-popover");
  if (existing) { existing.remove(); return; }

  const popover = document.createElement("div");
  popover.id = "template-picker-popover";
  popover.className = "template-picker";

  const panel = document.createElement("div");
  panel.className = "template-picker__panel";
  popover.appendChild(panel);

  const list = document.createElement("div");
  list.className = "template-picker__list";
  list.textContent = "加载中…";
  panel.appendChild(list);

  // 定位：锚定在按钮下方，右对齐（不超出视口）。
  const place = (): void => {
    const rect = opts.anchor.getBoundingClientRect();
    const pw = 220; // 面板固定宽度
    let top = rect.bottom + 6;
    let left = rect.right - pw;
    // 下溢 → 翻到按钮上方。
    if (top + 260 > window.innerHeight) top = rect.top - 6; // 260 ≈ max-height
    // 左溢 → 贴左边。
    if (left < 8) left = 8;
    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
    popover.style.width = `${pw}px`;
  };
  place();

  const close = (): void => { popover.remove(); };

  // 点外部关闭（下一 tick 挂，避免当前 click 冒泡触发立即关闭）。
  const onDocClick = (e: MouseEvent): void => {
    if (!popover.contains(e.target as Node) && e.target !== opts.anchor) {
      close();
      document.removeEventListener("click", onDocClick, true);
    }
  };
  setTimeout(() => document.addEventListener("click", onDocClick, true), 0);

  // Escape 关闭。
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); }
  };
  document.addEventListener("keydown", onKey);

  // resize / scroll 时重新定位。
  const reposition = (): void => { if (popover.isConnected) place(); };
  window.addEventListener("resize", reposition);
  window.addEventListener("scroll", reposition, true);

  // remove 时清理 listeners。
  const origRemove = popover.remove.bind(popover);
  popover.remove = () => {
    document.removeEventListener("click", onDocClick, true);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", reposition);
    window.removeEventListener("scroll", reposition, true);
    origRemove();
  };

  document.body.appendChild(popover);

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
    list.textContent = "未配置模板";
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
 * 「+」按钮：点击打开锚定模板选择器。移动端 / 桌面端共用。
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
  btn.addEventListener("click", () => openTemplatePicker({ anchor: btn, onStarted: opts.onStarted }));
  return btn;
}
