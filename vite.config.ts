import { defineConfig } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VitePWA } from "vite-plugin-pwa";

const __dirname = dirname(fileURLToPath(import.meta.url));

// PWA config lifted from OpenChamber (packages/web/vite.config.ts):
// - `injectManifest` strategy: keep our hand-written sw.ts but let Vite inject
//   the precache manifest at build time.
// - `rollupFormat: 'iife'`: iOS Safari is much more reliable with a classic
//   (non-module) SW bundle.
// - `manifest: false`: we ship our own /manifest.webmanifest from public/.
// - `registerType: 'autoUpdate'`: the new SW takes over on next reload; the
//   SPA surfaces a toast via register-sw.ts.
// - `injectRegister: false`: registration is done explicitly in main.ts so we
//   can gate on PROD, secure context, and prerender state.

export default defineConfig({
  root: "src/web",
  publicDir: "public",
  build: {
    outDir: resolve(__dirname, "dist/web"),
    emptyOutDir: true,
    sourcemap: true,
  },
  resolve: {
    alias: { "@shared": resolve(__dirname, "src/shared") },
  },
  plugins: [
    VitePWA({
      strategies: "injectManifest",
      srcDir: ".",
      filename: "sw.ts",
      registerType: "autoUpdate",
      injectRegister: false,
      manifest: false,
      injectManifest: {
        globPatterns: [
          "**/*.{js,css,html,ico,png,svg,webp,woff,woff2}",
        ],
        rollupFormat: "iife",
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
});
