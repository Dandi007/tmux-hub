import { uploadImageForSession, IMAGE_ACCEPT_ATTR } from "../upload/image-upload";
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
  btn.setAttribute("aria-label", "上传图片");
  btn.textContent = "📎";

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = IMAGE_ACCEPT_ATTR;
  fileInput.className = "mobile-toolbar__image-attach-input";
  fileInput.style.display = "none";

  deps.parent.append(btn, fileInput);

  const doUpload = async (session: string, file: File): Promise<void> => {
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = "...";
    try {
      const path = await uploadImageForSession(session, file);
      deps.openDrawer();
      const ta = deps.getTextarea();
      if (ta) {
        const before = ta.value.slice(0, ta.selectionStart ?? ta.value.length);
        const after = ta.value.slice(ta.selectionEnd ?? ta.value.length);
        const inserted = ` ${path} `;
        ta.value = before + inserted + after;
        const caret = before.length + inserted.length;
        ta.setSelectionRange(caret, caret);
        ta.focus();
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
    fileInput.value = ""; // allow re-picking the same file
    fileInput.click();
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const session = deps.getSession();
    if (!session) {
      showToast("session 已断开", "error");
      return;
    }
    void doUpload(session, file);
  });

  return btn;
}
