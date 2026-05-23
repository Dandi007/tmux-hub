let sentinel: WakeLockSentinel | null = null;

async function acquire(): Promise<void> {
  if (!("wakeLock" in navigator)) return;
  try {
    sentinel = await navigator.wakeLock.request("screen");
    sentinel.addEventListener("release", () => { sentinel = null; });
  } catch {
    sentinel = null;
  }
}

function onVisibilityChange(): void {
  if (document.visibilityState === "visible") void acquire();
}

export function enableWakeLock(): void {
  void acquire();
  document.addEventListener("visibilitychange", onVisibilityChange);
}
