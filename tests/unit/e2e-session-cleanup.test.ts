import { test, expect, afterAll } from "bun:test";
import { makeCreateSession } from "../e2e/helpers";

// E2E sessions used to outlive their test: the e2e tmux server is reused per
// checkout, so every run left its sessions behind, and every page load opens
// a ws per session — after a few hundred, attach tests timed out (RSI round
// 4/5). createSession now records what it made and cleanup() kills it through
// the same API a user's close button uses.
const killed: string[] = [];
let n = 0;
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/system/auth-check") return Response.json({ secret: "s3cret" });
    if (url.pathname === "/templates/shell/run" && req.method === "POST") {
      return Response.json({ name: `shell-${++n}` }, { status: 201 });
    }
    const m = /^\/sessions\/([^/]+)\/kill$/.exec(url.pathname);
    if (m && req.method === "POST") {
      if (req.headers.get("x-hub-secret") !== "s3cret" || req.headers.get("x-hub-confirm") !== "kill") {
        return new Response("forbidden", { status: 403 });
      }
      const name = decodeURIComponent(m[1]!);
      if (name === "shell-2") return new Response("gone", { status: 404 }); // test killed it itself
      killed.push(name);
      return Response.json({ ok: true });
    }
    return new Response("nope", { status: 404 });
  },
});
afterAll(() => server.stop(true));

test("cleanup kills every session createSession made, tolerating ones already gone", async () => {
  const { createSession, cleanup } = makeCreateSession(`http://127.0.0.1:${server.port}`);
  expect(await createSession()).toBe("shell-1");
  expect(await createSession()).toBe("shell-2");
  expect(await createSession()).toBe("shell-3");
  await cleanup();
  expect(killed.sort()).toEqual(["shell-1", "shell-3"]);
  // Idempotent: a second cleanup has nothing left to kill.
  await cleanup();
  expect(killed.length).toBe(2);
});
