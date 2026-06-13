// E2E test: server-side emulator snapshot path (TMUX_HUB_EMULATOR=1).
//
// Runs against the dedicated emulator hub (port 3202, TMUX_HUB_EMULATOR=1)
// defined in the "emulator" project in playwright.config.ts. Uses WebSocket
// connections directly — no built SPA/dist/web required.
//
// Key constraint (documented):
//   The hub's registry only exposes sessions in the managed-sessions DB.
//   Sessions created via raw `tmux new-session` after hub startup are
//   invisible to the registry (and the WS upgrade returns 410 "session not
//   found"). The hub auto-creates one managed shell-* session on startup
//   (when the registry is empty). This test uses that pre-existing session,
//   sends vim into it, and attaches via WS — avoiding the managed-DB
//   constraint entirely.
//
// Assertions:
//   1. Hub health endpoint is reachable (emulator project sanity).
//   2. A managed shell session exists at startup (hub auto-creates one).
//   3. Sending vim into the session + typing a marker results in the marker
//      being visible via tmux capture-pane (ground truth).
//   4. A WebSocket client connecting to /ws/sessions/:name receives a frame
//      that (a) starts with ESC c (RIS — the hard-reset prefix emitted by
//      SessionEmulator.snapshot()), and (b) contains the typed content.
//   5. A second WebSocket (late joiner) also receives the snapshot (ESC c prefix).
//   6. After exiting vim the pane shows a shell prompt, not vim tildes.
//
// Coverage gap (documented):
//   Pixel-level "no garble" in a rendered xterm canvas is not asserted.
//   xterm renders to canvas with no accessible text DOM. The snapshot bytes
//   are syntactically correct VT (proven by the unit/integration suite).
//   The tap-snapshot-flush ordering invariant is covered at the byte level
//   by tests/integration/emulator-attach.test.ts.

import { test, expect } from "./emulator-fixtures";

// Port where the emulator hub listens (matches playwright.config.ts E2E_EMU_PORT).
const EMU_HTTP = "http://127.0.0.1:3202";
const EMU_WS   = "ws://127.0.0.1:3202";

// Timeout for receiving the first WebSocket frame after connecting.
const FRAME_TIMEOUT_MS = 8_000;

/**
 * Fetch the hub secret from /system/auth-check.
 * In TMUX_HUB_DEV_BIND_SECRET=1 mode this returns without credentials.
 */
async function fetchSecret(page: import("@playwright/test").Page): Promise<string> {
  const resp = await page.request.get(`${EMU_HTTP}/system/auth-check`);
  if (!resp.ok()) throw new Error(`/system/auth-check returned ${resp.status()}`);
  const body = await resp.json() as { secret?: string };
  if (!body.secret) throw new Error(`auth-check missing secret: ${JSON.stringify(body)}`);
  return body.secret;
}

/**
 * Open a WebSocket to /ws/sessions/:name in the browser context and return
 * the first terminal data frame (binary or the first text frame that starts
 * with ESC c). The hub sends a JSON viewport message first on open, then
 * attachWithReplay sends the snapshot/replay. We skip JSON frames and return
 * the first non-JSON frame. The hub authenticates WS upgrades via ?token=.
 */
async function wsSnapshotFrame(
  page: import("@playwright/test").Page,
  sessionName: string,
  token: string,
): Promise<string> {
  return page.evaluate(
    async ({ wsBase, name, tok, timeout }) => {
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          ws.close();
          reject(`No terminal frame within ${timeout}ms for session "${name}"`);
        }, timeout);

        const url = `${wsBase}/ws/sessions/${encodeURIComponent(name)}?token=${encodeURIComponent(tok)}`;
        const ws = new WebSocket(url);
        ws.binaryType = "arraybuffer";

        ws.onmessage = (ev) => {
          const data = ev.data instanceof ArrayBuffer
            ? new TextDecoder().decode(ev.data as ArrayBuffer)
            : String(ev.data);
          // Skip JSON control frames (viewport, error messages).
          // Terminal data frames are binary (ArrayBuffer) or start with ESC.
          if (ev.data instanceof ArrayBuffer || data.startsWith("\x1b")) {
            clearTimeout(timer);
            ws.close();
            resolve(data);
          }
          // Otherwise keep waiting for the next frame.
        };

        ws.onerror = () => {
          clearTimeout(timer);
          reject("WebSocket error");
        };

        ws.onclose = (ev) => {
          if (ev.code !== 1000 && ev.code !== 1001) {
            clearTimeout(timer);
            reject(`WebSocket closed unexpectedly: code=${ev.code}`);
          }
        };
      });
    },
    { wsBase: EMU_WS, name: sessionName, tok: token, timeout: FRAME_TIMEOUT_MS },
  );
}

test.describe("emulator snapshot path — interactive TUI attach", () => {
  test("emulator hub health endpoint is reachable", async ({ page }) => {
    // Proves the second webServer (port 3202, TMUX_HUB_EMULATOR=1) started.
    const r = await page.request.get(`${EMU_HTTP}/system/health`);
    expect(r.status()).toBe(200);
  });

  test("vim attach via managed session delivers ESC-c snapshot with TUI content", async ({
    page,
    ctx,
    context,
  }) => {
    // Find the auto-created managed session. The hub creates a shell-* session
    // at startup when the registry is empty. We use it rather than creating a
    // new one: sessions created via raw tmux after hub startup are not in the
    // managed-sessions DB and the WS upgrade returns 410 "session not found".
    const sessions = ctx.tmuxE2E(["list-sessions", "-F", "#{session_name}"]).split("\n").filter(Boolean);
    expect(sessions.length, "Expected at least one managed session to exist at startup").toBeGreaterThan(0);
    const name = sessions[0]!;

    // Send vim into the existing shell session.
    // -u NONE: no user vimrc (deterministic); -n: no swap file (no ATTENTION dialog).
    const vimFile = `/tmp/e2e-emu-${name}.txt`;
    ctx.tmuxE2E(["send-keys", "-t", name, `vim -u NONE -n ${vimFile}`, "Enter"]);

    // Give vim time to draw its initial screen (tildes + status bar).
    await page.waitForTimeout(800);

    // Drive vim: insert mode → type marker → Escape back to normal mode.
    ctx.tmuxE2E(["send-keys", "-t", name, "i",              ""]);
    await page.waitForTimeout(150);
    ctx.tmuxE2E(["send-keys", "-t", name, "EMU_E2E_MARKER", ""]);
    await page.waitForTimeout(150);
    ctx.tmuxE2E(["send-keys", "-t", name, "Escape",         ""]);

    // Wait for the hub's poll loop (5 ms interval) to ingest the bytes into
    // the emulator's internal terminal buffer.
    await page.waitForTimeout(600);

    // Ground-truth: tmux can see the marker in the pane.
    const beforeAttach = ctx.tmuxE2E(["capture-pane", "-p", "-t", name]);
    expect(beforeAttach, "tmux capture-pane should show the typed marker").toContain("EMU_E2E_MARKER");
    expect(beforeAttach, "vim empty-line tildes should be present").toMatch(/~/);

    // Obtain the hub secret for WS auth (?token=).
    const token = await fetchSecret(page);

    // --- First client attaches ---
    const frame1 = await wsSnapshotFrame(page, name, token);

    // Core assertion: the emulator snapshot path sends a frame starting with
    // ESC c (\x1b\x63 = RIS "reset to initial state"). This is the hard-reset
    // prefix emitted by SessionEmulator.snapshot() before the serialized buffer.
    // Both the emulator path and the legacy slice path start with "\x1bc", but
    // only the emulator path re-serializes the rendered screen coherently.
    // We assert structural correctness (ESC c prefix) AND content (marker present).
    const ESC_C = "\x1b\x63";
    expect(
      frame1.startsWith(ESC_C),
      `Frame 1 should start with ESC c. Got: ${JSON.stringify(frame1.slice(0, 30))}`,
    ).toBe(true);
    expect(frame1, "Frame 1 should contain the vim content typed before attach")
      .toContain("EMU_E2E_MARKER");

    // --- Second client (late joiner) attaches mid-session ---
    // Fresh page → fresh WS connection → attachWithReplay called again on the
    // emulator path. This is the key "late joiner sees coherent snapshot" case.
    const page2 = await context.newPage();
    const frame2 = await wsSnapshotFrame(page2, name, token);
    await page2.close();

    expect(
      frame2.startsWith(ESC_C),
      `Late-joiner frame should start with ESC c. Got: ${JSON.stringify(frame2.slice(0, 30))}`,
    ).toBe(true);
    expect(frame2, "Late-joiner frame should also contain the TUI content")
      .toContain("EMU_E2E_MARKER");

    // --- Exit vim, verify shell is back ---
    ctx.tmuxE2E(["send-keys", "-t", name, ":q!", "Enter"]);
    await page.waitForTimeout(800);

    const afterExit = ctx.tmuxE2E(["capture-pane", "-p", "-t", name]);
    // After exit, vim's ~ empty-line markers should be gone (shell prompt shown).
    expect(afterExit, "After vim exit, vim tildes should be gone").not.toMatch(/^~\s*$/m);
  });
});
