// Install prompt — OpenChamber pattern but vanilla TS.
// When Chrome / Edge fires `beforeinstallprompt`, we stash the event, then
// show a non-modal toast with a "安装" action button. Clicking calls
// `prompt()` on the stashed event. After `appinstalled`, we suppress further
// prompts for the rest of the browser session.
//
// We honour a sessionStorage flag so we don't pester the user every reload —
// matches OpenChamber's `pwa-install-toast-shown` heuristic.

import { showActionToast, dismissToast } from "../ui/toast";

const INSTALL_TOAST_SESSION_KEY = "tmux-hub.pwa-install-toast-shown";

type InstallPromptOutcome = "accepted" | "dismissed";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: InstallPromptOutcome }>;
};

function isStandaloneMode(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  const navStandalone = (window.navigator as { standalone?: boolean }).standalone;
  return navStandalone === true;
}

function safeSessionStorage(): Pick<Storage, "getItem" | "setItem"> {
  try {
    const ss = window.sessionStorage;
    ss.getItem(INSTALL_TOAST_SESSION_KEY);
    return ss;
  } catch {
    const memo = new Map<string, string>();
    return {
      getItem: (k: string) => memo.get(k) ?? null,
      setItem: (k: string, v: string) => {
        memo.set(k, v);
      },
    };
  }
}

export function attachInstallPrompt(): () => void {
  if (typeof window === "undefined") return () => {};
  if (isStandaloneMode()) return () => {};

  let deferredPrompt: BeforeInstallPromptEvent | null = null;
  let toastId: string | null = null;

  const dismiss = () => {
    if (toastId) {
      dismissToast(toastId);
      toastId = null;
    }
  };

  const triggerInstall = async () => {
    const ev = deferredPrompt;
    if (!ev) return;
    deferredPrompt = null;
    dismiss();
    try {
      await ev.prompt();
      const { outcome } = await ev.userChoice;
      if (outcome === "accepted") {
        showActionToast("正在安装 tmux-hub 到桌面…", { duration: 4000 });
      }
    } catch (e) {
      console.warn("[PWA] install prompt failed:", e);
    }
  };

  const onBeforeInstallPrompt = (event: Event) => {
    const install = event as BeforeInstallPromptEvent;
    if (typeof install.prompt !== "function") return;
    install.preventDefault();
    deferredPrompt = install;

    const ss = safeSessionStorage();
    if (ss.getItem(INSTALL_TOAST_SESSION_KEY) === "true") return;
    ss.setItem(INSTALL_TOAST_SESSION_KEY, "true");

    toastId = showActionToast("把 tmux-hub 装到桌面，从 Dock 直接打开。", {
      action: { label: "安装", onClick: () => void triggerInstall() },
      duration: 12000,
    });
  };

  const onAppInstalled = () => {
    deferredPrompt = null;
    dismiss();
    showActionToast("tmux-hub 已安装到桌面。", { duration: 4000 });
  };

  window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt as EventListener);
  window.addEventListener("appinstalled", onAppInstalled);

  return () => {
    dismiss();
    window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt as EventListener);
    window.removeEventListener("appinstalled", onAppInstalled);
  };
}
