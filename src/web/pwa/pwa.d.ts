// Ambient module declarations for vite-plugin-pwa virtual modules.
// Mirrors OpenChamber's pwa.d.ts; the real types live inside vite-plugin-pwa
// but our tsconfig doesn't pick them up automatically because we don't ship a
// vite/client types reference.

declare module "virtual:pwa-register" {
  export type RegisterSWOptions = {
    immediate?: boolean;
    onNeedRefresh?: () => void;
    onOfflineReady?: () => void;
    onRegistered?: (registration: ServiceWorkerRegistration | undefined) => void;
    onRegisteredSW?: (
      swScriptUrl: string,
      registration: ServiceWorkerRegistration | undefined,
    ) => void;
    onRegisterError?: (error: unknown) => void;
  };

  export function registerSW(
    options?: RegisterSWOptions,
  ): (reloadPage?: boolean) => Promise<void>;
}
