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
      for (const t of templates) {
        const row = document.createElement("div");
        row.className = "template-drawer__row";

        const select = document.createElement("select");
        select.dataset.id = t.id;
        for (const c of t.cwd_choices) {
          const opt = document.createElement("option");
          opt.value = c;
          opt.textContent = c;
          select.appendChild(opt);
        }

        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = t.name;
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            const r = await hubFetch(`/templates/${encodeURIComponent(t.id)}/run`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ cwd: select.value }),
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

        row.append(select, btn);
        el.appendChild(row);
      }
    })
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      showToast(`模板加载失败: ${msg}`, "error");
    });

  return el;
}
