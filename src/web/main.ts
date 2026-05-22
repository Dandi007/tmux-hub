import "./style.css";
import "./ui/toast.css";
import "./ui/confirm-modal.css";

const root = document.getElementById("app");
if (!root) throw new Error("#app missing");

const isMobile = () => matchMedia("(max-width: 720px)").matches;

if (isMobile()) {
  import("./mobile/mobile-view").then((m) => m.renderMobile(root));
} else {
  import("./desktop/desktop-view").then((m) => m.renderDesktop(root));
}
