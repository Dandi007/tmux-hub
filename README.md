# tmux-hub

Browser bridge to tmux sessions on dev Mac. Pipe-pane based output broadcast + send-keys input + template-driven session spawn.

Spec and implementation plan live under [`docs/superpowers/`](docs/superpowers/).

## Dev

```bash
bun install
bun run dev
```

## Test

```bash
bun test                                # unit + integration (74+ tests)
bunx playwright test --project=pwa      # PWA smoke (5 tests)
bun run test:e2e                        # full Playwright suite
```

## Install as a PWA (Phase 1)

`tmux-hub` is installable from Chrome / Edge / Brave on `https://tui.qinglinzhang.xyz`:

1. Open the site, accept Cloudflare Access (passkey / email OTP).
2. Address bar shows an "Install tmux-hub" button — click it.
3. Launches in a standalone window (no tab bar, no address bar).
4. Right-click the Dock / taskbar icon for "新会话 (zsh)" and "会话列表" shortcuts.
5. Offline launch shows the cached shell with a "未连接 hub" placeholder; the first API call surfaces a re-login prompt within ~1 s on 401.

Implementation details: see `docs/superpowers/specs/2026-05-22-pwa-chrome-app-design.md` and `docs/superpowers/plans/2026-05-22-pwa-chrome-app.md`. The PWA stack (vite-plugin-pwa + injectManifest + iife SW + Workbox precaching) is modeled on OpenChamber's `packages/web` and adapted to the Cloudflare Access cookie flow.

Phase 2+ follow-ups (push notifications, `file_handlers`, `launch_handler`, `protocol_handlers`, Background Sync, painting tabs into the Window Controls Overlay) are tracked in [Issue #1](https://github.com/Dandi007/tmux-hub/issues/1) and deliberately not in Phase 1 scope.
