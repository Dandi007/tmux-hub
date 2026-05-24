import "./style.css";
import "./ui/toast.css";
import "./ui/confirm-modal.css";

import { attachInstallPrompt } from "./pwa/install-prompt";
import {
  registerPwaServiceWorker,
  unregisterDevelopmentServiceWorkers,
} from "./pwa/register-sw";
import {
  applyLaunchQueryActions,
  focusSessionList,
  requestNewZshSession,
} from "./pwa/shortcuts";

const root = document.getElementById("app");
if (!root) throw new Error("#app missing");

const isMobile = () => matchMedia("(max-width: 720px)").matches || matchMedia("(pointer: coarse)").matches;

async function bootstrap() {
  if (isMobile()) {
    const m = await import("./mobile/mobile-view");
    m.renderMobile(root!);
  } else {
    const m = await import("./desktop/desktop-view");
    m.renderDesktop(root!);
  }
  applyLaunchQueryActions({
    onNewSession: () => void requestNewZshSession(),
    onFocusList: () => focusSessionList(),
  });
}
void bootstrap();

if (import.meta.env.PROD) {
  registerPwaServiceWorker();
} else {
  unregisterDevelopmentServiceWorkers();
}
attachInstallPrompt();
