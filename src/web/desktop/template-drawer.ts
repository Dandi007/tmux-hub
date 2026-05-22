import { showToast } from "../ui/toast";
import { hubFetch } from "../hub-fetch";

type TemplateDTO = { id: string; name: string; cwd_choices: string[] };

export function renderTemplateDrawer(parent: HTMLElement, onStarted: (name: string) => void): HTMLElement {
  const el = document.createElement("section");
  el.className = "template-drawer";
  parent.appendChild(el);

  const heading = document.createElement("div");
  heading.className = "template-drawer__heading";
  heading.textContent = "新会话";
  el.appendChild(heading);

  void hubFetch("/templates")
    .then((r) => r.json())
    .then((templates: TemplateDTO[]) => {
      // One button per template; cwd auto-uses cwd_choices[0]. Users that
      // want a different cwd/command cd / run from inside the new session.
      for (const t of templates) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "template-drawer__btn";
        btn.textContent = t.name;
        const cwd = t.cwd_choices[0] ?? "~";
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            const r = await hubFetch(`/templates/${encodeURIComponent(t.id)}/run`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ cwd }),
            });
            if (r.ok) {
              const body = (await r.json()) as { name: string };
              onStarted(body.name);
            } else {
              const text = await r.text();
              showToast(`启动失败: ${text}`, "error");
            }
          } catch (e) {
            showToast(`启动出错: ${(e as Error).message}`, "error");
          } finally {
            btn.disabled = false;
          }
        });
        el.appendChild(btn);
      }
    })
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      showToast(`模板加载失败: ${msg}`, "error");
    });

  return el;
}
