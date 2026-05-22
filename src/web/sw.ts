/// <reference lib="webworker" />

// tmux-hub Service Worker
//
// Strategy (spec §3.2):
//   - App shell (JS/CSS/HTML/icons) — precache + cache-first; backed by the
//     Workbox-injected __WB_MANIFEST so each build gets fresh revisions.
//   - WebSocket (/ws/sessions/*) — never intercepted; the SW cannot proxy WS
//     frames, and intercepting risks breaking upgrades.
//   - API and dynamic JSON (/api, /templates, /events, /sessions, /system/*) —
//     network-only pass-through; never written to cache.
//   - Cross-origin / opaque / 3xx redirect responses — never cached. This is
//     critical because Cloudflare Access returns a 302 to the OAuth flow when
//     the cookie is missing; caching that HTML would brick the PWA on next
//     load.
//
// We intentionally do NOT pull in workbox-routing/strategies runtime modules —
// keeps the SW bundle small and lets us inline simple, auditable logic. The
// only Workbox concept we lean on is `precacheAndRoute` for app-shell URLs.
//
// NOTE: built as `iife` (see vite.config.ts) so iOS Safari stays happy with
// classic-script service workers.

import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision?: string | null }>;
};

const SHELL_CACHE = "tmux-hub-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await cleanupOutdatedCaches();
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k.startsWith("tmux-hub-"))
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

precacheAndRoute(self.__WB_MANIFEST ?? []);

const API_PREFIXES = [
  "/api/",
  "/templates",
  "/sessions",
  "/events",
  "/system/",
  "/ws/sessions/",
];

function isApiOrLivePath(pathname: string): boolean {
  return API_PREFIXES.some((p) =>
    p.endsWith("/")
      ? pathname.startsWith(p)
      : pathname === p || pathname.startsWith(`${p}/`),
  );
}

function isCacheableShellRequest(req: Request, url: URL): boolean {
  if (req.method !== "GET") return false;
  if (url.origin !== self.location.origin) return false;
  if (isApiOrLivePath(url.pathname)) return false;
  return true;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (isApiOrLivePath(url.pathname) || url.pathname.startsWith("/ws/")) {
    return;
  }
  if (req.mode === "navigate") {
    event.respondWith(handleNavigation(req));
    return;
  }
  if (isCacheableShellRequest(req, url)) {
    event.respondWith(handleShellAsset(req));
  }
});

async function handleNavigation(req: Request): Promise<Response> {
  try {
    const networkResp = await fetch(req);
    // Never cache redirect chains; CF Access returns 302 to the OAuth flow
    // when the cookie has expired.
    if (
      networkResp.redirected ||
      networkResp.type === "opaqueredirect" ||
      (networkResp.status >= 300 && networkResp.status < 400)
    ) {
      return networkResp;
    }
    if (networkResp.ok && req.method === "GET") {
      const cache = await caches.open(SHELL_CACHE);
      cache.put("/index.html", networkResp.clone()).catch(() => {});
    }
    return networkResp;
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    const cached =
      (await cache.match("/index.html")) ?? (await caches.match("/index.html"));
    if (cached) return cached;
    return new Response(
      "<!doctype html><html><body><p>tmux-hub 暂不可用（离线，壳未缓存）。</p></body></html>",
      {
        headers: { "content-type": "text/html; charset=utf-8" },
        status: 503,
      },
    );
  }
}

async function handleShellAsset(req: Request): Promise<Response> {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(req);
  if (cached) {
    void revalidate(cache, req);
    return cached;
  }
  return revalidate(cache, req);
}

async function revalidate(cache: Cache, req: Request): Promise<Response> {
  try {
    const resp = await fetch(req);
    if (resp.ok && resp.type === "basic") {
      cache.put(req, resp.clone()).catch(() => {});
    }
    return resp;
  } catch {
    const fallback = await cache.match(req);
    if (fallback) return fallback;
    return new Response("offline", { status: 503 });
  }
}
