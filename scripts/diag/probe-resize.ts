// scripts/diag/probe-resize.ts
// Reproduce: bug 2 root-cause — server pins window to hardcoded 200x50 on WS open
// regardless of client's actual viewport. We connect a WS, observe server window
// size at multiple moments, then send a client-side resize and observe the change.
//
// Run with: bun run scripts/diag/probe-resize.ts <session-name> [client-cols] [client-rows]

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const SESSION = process.argv[2] ?? "tmux-hub-svc";
const CLIENT_COLS = Number(process.argv[3] ?? 160);
const CLIENT_ROWS = Number(process.argv[4] ?? 40);
const SECRET_PATH = process.env.TMUX_HUB_SECRET_PATH ??
  resolve(homedir(), ".config/tmux-hub/hub.secret");
const HOST = process.env.TMUX_HUB_HOST ?? "127.0.0.1";
const PORT = process.env.TMUX_HUB_PORT ?? "3101";

const secret = readFileSync(SECRET_PATH, "utf8").trim();
// Real client passes cols/rows on the WS URL so server pins to client viewport
// BEFORE capturing snapshot. Toggle with --legacy to omit them (old buggy behavior).
const LEGACY = process.argv.includes("--legacy");
const sizeQuery = LEGACY ? "" : `&cols=${CLIENT_COLS}&rows=${CLIENT_ROWS}`;
const wsUrl = `ws://${HOST}:${PORT}/ws/sessions/${encodeURIComponent(SESSION)}?token=${secret}${sizeQuery}`;
console.log(`[probe] mode=${LEGACY ? "legacy (no query size)" : "new (cols/rows in query)"}`);

async function tmuxSize(session: string): Promise<string> {
  const proc = Bun.spawn(["tmux", "display", "-p", "-t", `${session}:0`, "#{window_width}x#{window_height}"], {
    stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

async function snap(label: string) {
  const size = await tmuxSize(SESSION);
  console.log(`[${label}] server window ${SESSION}:0 = ${size}`);
  return size;
}

console.log(`== probe-resize: session=${SESSION} client=${CLIENT_COLS}x${CLIENT_ROWS} ==`);
const before = await snap("t0 before-ws");

const ws = new WebSocket(wsUrl);
ws.binaryType = "arraybuffer";

let initialBytes = 0;
let messages = 0;

await new Promise<void>((res, rej) => {
  const timer = setTimeout(() => rej(new Error("ws open timeout")), 3000);
  ws.onopen = () => { clearTimeout(timer); res(); };
  ws.onerror = (e) => { clearTimeout(timer); rej(new Error(`ws error: ${String(e)}`)); };
});
console.log("[ws] open");

await new Promise((r) => setTimeout(r, 50));
const afterPin = await snap("t1 after-pin");

ws.onmessage = (m) => {
  messages++;
  if (m.data instanceof ArrayBuffer) initialBytes += m.data.byteLength;
  else if (typeof m.data === "string") initialBytes += m.data.length;
};

await new Promise((r) => setTimeout(r, 300));
const afterSnap = await snap("t2 after-snapshot");
console.log(`[snapshot] ${messages} message(s) totaling ~${initialBytes} bytes`);

console.log(`[client] send resize {cols:${CLIENT_COLS}, rows:${CLIENT_ROWS}}`);
ws.send(JSON.stringify({ kind: "resize", cols: CLIENT_COLS, rows: CLIENT_ROWS }));
await new Promise((r) => setTimeout(r, 200));
const afterResize = await snap("t3 after-client-resize");

ws.close();
await new Promise((r) => setTimeout(r, 100));
const afterClose = await snap("t4 after-ws-close");

console.log();
console.log("== summary ==");
console.log(`before:   ${before}`);
console.log(`pin:      ${afterPin}     (expect 200x50 if bug 2 present)`);
console.log(`snap:     ${afterSnap}`);
console.log(`resize:   ${afterResize}  (server after client tells real size)`);
console.log(`close:    ${afterClose}`);
console.log();
if (afterPin === "200x50" && afterResize === `${CLIENT_COLS}x${CLIENT_ROWS}`) {
  console.log("RC CONFIRMED: server pins to hardcoded 200x50, then resizes after client message.");
  console.log("              Initial snapshot is captured at 200x50 but xterm renders at client size.");
} else if (afterPin === before) {
  console.log("NOT reproduced: server window did not change on WS open.");
} else {
  console.log(`Partial: server window changed unexpectedly (${before} -> ${afterPin}).`);
}
