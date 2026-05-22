import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { tmuxTest, tmuxTestKillServer } from "../helpers/tmux-test";
import { buildSessionControlRoutes } from "../../src/server/session-control";
import { BroadcasterRegistry } from "../../src/server/output-broadcaster";

const S = "user-sc-" + Date.now().toString().slice(-8);
const broadcasters = new BroadcasterRegistry();

beforeAll(async () => {
  await tmuxTest(["new-session", "-d", "-s", S, "sleep 30"]);
});

afterAll(async () => {
  await tmuxTest(["kill-session", "-t", S]).catch(() => {});
  await broadcasters.stopAll();
  await tmuxTestKillServer();
});

function makeApp() {
  const app = new Hono();
  app.route("/", buildSessionControlRoutes({ broadcasters, tmuxRun: tmuxTest }));
  return app;
}

async function fetchApp(app: Hono, path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`http://localhost${path}`, init));
}

describe("session-control routes", () => {
  test("rejects bad session name grammar (POST /sessions/Bad/detach → 400)", async () => {
    const app = makeApp();
    const r = await fetchApp(app, "/sessions/Bad.Name/detach", { method: "POST" });
    expect(r.status).toBe(400);
  });

  test("rejects kill without X-Hub-Confirm header (→ 428)", async () => {
    const app = makeApp();
    const r = await fetchApp(app, `/sessions/${S}/kill`, { method: "POST" });
    expect(r.status).toBe(428);
  });

  test("kill with confirm header succeeds", async () => {
    const ephemeral = "user-sce-" + Date.now().toString().slice(-8);
    await tmuxTest(["new-session", "-d", "-s", ephemeral, "sleep 30"]);
    const app = makeApp();
    const r = await fetchApp(app, `/sessions/${ephemeral}/kill`, {
      method: "POST",
      headers: { "x-hub-confirm": "kill" },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    const list = await tmuxTest(["list-sessions", "-F", "#{session_name}"]);
    expect(list.stdout.split("\n")).not.toContain(ephemeral);
  });

  test("rename rejects bad target grammar (uppercase/dot)", async () => {
    const app = makeApp();
    const r = await fetchApp(app, `/sessions/${S}/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "Bad.Name" }),
    });
    expect(r.status).toBe(400);
  });

  test("rename to valid user- name", async () => {
    const ephemeral = "user-scrn-" + Date.now().toString().slice(-8);
    const newName = "user-scrn-renamed";
    await tmuxTest(["new-session", "-d", "-s", ephemeral, "sleep 30"]);
    const app = makeApp();
    const r = await fetchApp(app, `/sessions/${ephemeral}/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: newName }),
    });
    expect(r.status).toBe(200);
    await tmuxTest(["kill-session", "-t", newName]).catch(() => {});
  });

  test("refresh returns capture-pane snapshot text", async () => {
    const app = makeApp();
    const r = await fetchApp(app, `/sessions/${S}/refresh`, { method: "POST" });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(typeof text).toBe("string");
  });

  test("rename non-existent session returns 400", async () => {
    const app = makeApp();
    const r = await fetchApp(app, `/sessions/user-nosuch-99999999/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "user-something-else" }),
    });
    expect(r.status).toBe(400);
  });
});
