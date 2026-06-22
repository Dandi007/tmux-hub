// Defensive SW registration — pattern lifted from OpenChamber
// (packages/web/src/main.tsx). Skips registration when:
//   - service workers are not supported
//   - the document is prerendering (Chrome speculation rules)
//   - we're not on http/https (e.g. file://)
//
// Registration runs after the `load` event so it doesn't fight the SPA
// bootstrap for the network. Update detection surfaces a toast via the
// existing showToast primitive.

import { registerSW } from "virtual:pwa-register";
import { showToast } from "../ui/toast";

type PrerenderingDocument = Document & { prerendering?: boolean };

function canUseServiceWorker(): boolean {
  if (!("serviceWorker" in navigator)) return false;
  if (!window.isSecureContext) return false;
  const scheme = window.location.protocol;
  if (scheme !== "http:" && scheme !== "https:") return false;
  const docState = document as PrerenderingDocument;
  if (docState.prerendering || String(document.visibilityState) === "prerender") return false;
  return true;
}

function runWhenReady(task: () => void): void {
  let fired = false;
  const run = () => {
    if (fired) return;
    if (canUseServiceWorker()) {
      fired = true;
      task();
    }
  };
  const afterLoad = () => setTimeout(run, 0);
  if (document.readyState === "complete") afterLoad();
  else window.addEventListener("load", afterLoad, { once: true });
  const docState = document as PrerenderingDocument;
  if (docState.prerendering || String(document.visibilityState) === "prerender") {
    document.addEventListener("visibilitychange", run, { once: true });
  }
}

export function registerPwaServiceWorker(): void {
  runWhenReady(() => {
    try {
      const updateSW = registerSW({
        immediate: false,
        onRegisteredSW(_swUrl, registration) {
          // 定时探测新 sw.js：PWA 常驻不刷新（尤其 iOS standalone 切后台再回来不重载），
          // 不轮询就一直跑旧 bundle。每 60s update() 一次，发现新版触发 onNeedRefresh。
          if (registration) {
            setInterval(() => { void registration.update().catch(() => {}); }, 60_000);
          }
        },
        onNeedRefresh() {
          // 自动刷新到新版本（updateSW(true) = skipWaiting + reload）。
          // 之前用 updateSW(false) 只换 SW 不重载 → 页面一直跑旧 JS（陈旧缓存根因）。
          showToast("检测到新版本，正在刷新…", "info");
          void updateSW(true);
        },
        onOfflineReady() {
          showToast("已可离线使用 tmux-hub 壳", "info");
        },
        onRegisterError(error: unknown) {
          console.warn("[PWA] service worker registration failed:", error);
        },
      });
    } catch (error) {
      console.warn("[PWA] service worker registration skipped:", error);
    }
  });
}

export function unregisterDevelopmentServiceWorkers(): void {
  runWhenReady(() => {
    void navigator.serviceWorker
      .getRegistrations()
      .then((registrations) => Promise.all(registrations.map((r) => r.unregister())))
      .catch(() => {});
  });
}
