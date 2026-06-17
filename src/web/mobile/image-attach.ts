import { uploadFilesSequential, FILE_ACCEPT_ATTR } from "../upload/image-upload";
import { showToast } from "../ui/toast";

export type ImageAttachDeps = {
  parent: HTMLElement;
  getSession: () => string | null;
  getTextarea: () => HTMLTextAreaElement | null;
  openDrawer: () => void;
};

export function renderImageAttachButton(deps: ImageAttachDeps): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mobile-toolbar__image-attach";
  btn.setAttribute("aria-label", "上传文件");
  btn.textContent = "📎";

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = FILE_ACCEPT_ATTR;
  fileInput.multiple = true;
  fileInput.className = "mobile-toolbar__image-attach-input";
  fileInput.style.display = "none";

  deps.parent.append(btn, fileInput);

  const doUpload = async (session: string, files: File[]): Promise<void> => {
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = "...";
    try {
      const { paths, errors } = await uploadFilesSequential(session, files);
      if (paths.length > 0) {
        deps.openDrawer();
        const ta = deps.getTextarea();
        if (ta) {
          const before = ta.value.slice(0, ta.selectionStart ?? ta.value.length);
          const after = ta.value.slice(ta.selectionEnd ?? ta.value.length);
          const inserted = ` ${paths.join(" ")} `;
          ta.value = before + inserted + after;
          const caret = before.length + inserted.length;
          ta.setSelectionRange(caret, caret);
          ta.focus();
        }
      }
      for (const err of errors) {
        showToast(`上传失败：${err.name} — ${err.message}`, "error");
      }
    } catch (e) {
      showToast(`上传失败：${(e as Error).message}`, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  };

  btn.addEventListener("click", () => {
    const session = deps.getSession();
    if (!session) {
      showToast("先选一个 session", "error");
      return;
    }
    fileInput.value = ""; // allow re-picking the same file(s)
    fileInput.click();
  });

  fileInput.addEventListener("change", () => {
    const files = Array.from(fileInput.files ?? []);
    if (files.length === 0) return;
    const session = deps.getSession();
    if (!session) {
      showToast("session 已断开", "error");
      return;
    }
    void doUpload(session, files);
  });

  return btn;
}
