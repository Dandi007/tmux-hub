import { test, expect } from "bun:test";
import { resolve } from "node:path";

const helper = resolve(import.meta.dir, "../../deploy/dogfood-health.zsh");
const ready = '{"ok":true,"commit":"abc123"}';
async function check(url: string) {
  // zsh argv keeps paths and URL out of shell interpolation. No service,
  // checkout, host env, or real deployment is involved in these regressions.
  const p = Bun.spawn(["zsh", "-ec", 'source "$1"; wait_for_dogfood_health "$2"; print READY_MARKER', "probe", helper, url], {
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    p.exited, new Response(p.stdout).text(), new Response(p.stderr).text(),
  ]);
  return { code, stdout, stderr };
}
function unusedPort(): number {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(ready) });
  const port = s.port!;
  s.stop(true);
  return port;
}

test("a ready dogfood endpoint completes deployment readiness immediately", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(ready) });
  try {
    const r = await check(`http://127.0.0.1:${server.port}/system/health`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(ready);
    expect(r.stdout).toContain("READY_MARKER");
  } finally { server.stop(true); }
});

test("a listener starting after restart is awaited instead of failing deployment", async () => {
  const port = unusedPort();
  let server: ReturnType<typeof Bun.serve> | undefined;
  const timer = setTimeout(() => {
    server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response(ready) });
  }, 300);
  try {
    const r = await check(`http://127.0.0.1:${port}/system/health`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("READY_MARKER");
    expect(r.stdout).toContain(ready);
  } finally { clearTimeout(timer); server?.stop(true); }
});

test("temporary unavailable health is retried until it becomes ready", async () => {
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    calls++;
    return calls === 1 ? new Response("starting", { status: 503 }) : new Response(ready);
  } });
  try {
    const r = await check(`http://127.0.0.1:${server.port}/system/health`);
    expect(r.code).toBe(0);
    expect(calls).toBe(2);
    expect(r.stdout).toContain("READY_MARKER");
  } finally { server.stop(true); }
});

test("a permanently closed listener fails within a bound and never reaches success", async () => {
  const started = performance.now();
  const r = await check(`http://127.0.0.1:${unusedPort()}/system/health`);
  expect(r.code).toBe(7);
  expect(r.stdout).not.toContain("READY_MARKER");
  expect(r.stderr).toContain("curl 退出码 7");
  expect(performance.now() - started).toBeLessThan(12000);
}, 15000);

test("a permanent HTTP error preserves curl failure and stops deployment", async () => {
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    calls++;
    return new Response("forbidden", { status: 403 });
  } });
  try {
    const r = await check(`http://127.0.0.1:${server.port}/system/health`);
    expect(r.code).toBe(22);
    expect(calls).toBe(1);
    expect(r.stdout).not.toContain("READY_MARKER");
    expect(r.stderr).toContain("curl 退出码 22");
  } finally { server.stop(true); }
});
