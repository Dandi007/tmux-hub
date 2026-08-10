import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { buildUploadBrokerRoutes } from "../../src/server/upload-broker";

const SESSION = "user-ub-1";
const TOKEN = "broker-token-0123456789abcdef";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Call = { url: string; init?: RequestInit };

function harness(
  over: {
    enabled?: boolean;
    sessionExists?: (n: string) => boolean;
    respond?: (url: string) => Response | Promise<Response>;
    throwOn?: RegExp;
  } = {},
) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (over.throwOn?.test(url)) throw new Error("ECONNREFUSED");
    return over.respond ? over.respond(url) : json({ ok: true });
  }) as unknown as typeof fetch;

  const app = new Hono();
  app.route(
    "/",
    buildUploadBrokerRoutes({
      enabled: over.enabled ?? true,
      base: "http://127.0.0.1:8105",
      namespace: "tmux-hub",
      token: TOKEN,
      sessionExists: over.sessionExists ?? ((n) => n === SESSION),
      fetchImpl,
    }),
  );
  return { app, calls };
}

const post = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("upload-init", () => {
  test("透传签名，并带上 namespace 与 token", async () => {
    const { app, calls } = harness({
      respond: () => json({ uploadId: "u1", endpoint: "https://tos/", fields: {} }),
    });
    const r = await app.fetch(
      post(`/sessions/${SESSION}/upload-init`, { filename: "a.png", size: 10, mime: "image/png" }),
    );
    expect(r.status).toBe(200);
    expect((await r.json() as any).uploadId).toBe("u1");

    expect(calls[0]!.url).toBe("http://127.0.0.1:8105/v1/uploads/init");
    const h = calls[0]!.init!.headers as Record<string, string>;
    expect(h["x-upload-namespace"]).toBe("tmux-hub");
    expect(h.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
      filename: "a.png",
      size: 10,
      mime: "image/png",
    });
  });

  test("broker 未启用 → 501，前端据此降级", async () => {
    const { app, calls } = harness({ enabled: false });
    const r = await app.fetch(post(`/sessions/${SESSION}/upload-init`, { size: 1 }));
    expect(r.status).toBe(501);
    expect(calls).toHaveLength(0);
  });

  test("会话不存在 → 410，不打 broker", async () => {
    const { app, calls } = harness();
    const r = await app.fetch(post(`/sessions/user-gone-9/upload-init`, { size: 1 }));
    expect(r.status).toBe(410);
    expect(calls).toHaveLength(0);
  });

  test("非法会话名 → 400", async () => {
    const { app } = harness({ sessionExists: () => true });
    const r = await app.fetch(post(`/sessions/bad%20name/upload-init`, { size: 1 }));
    expect(r.status).toBe(400);
  });

  test("broker 连不上 → 502，前端降级", async () => {
    const { app } = harness({ throwOn: /uploads\/init/ });
    const r = await app.fetch(post(`/sessions/${SESSION}/upload-init`, { size: 1 }));
    expect(r.status).toBe(502);
  });

  test("broker 的错误状态码原样透传（413 不该被吞成 500）", async () => {
    const { app } = harness({
      respond: () => json({ error: "too large", code: "too-large" }, 413),
    });
    const r = await app.fetch(post(`/sessions/${SESSION}/upload-init`, { size: 99999999 }));
    expect(r.status).toBe(413);
    expect((await r.json() as any).code).toBe("too-large");
  });

  test("body 不是 JSON → 400", async () => {
    const { app } = harness();
    const r = await app.fetch(
      new Request(`http://localhost/sessions/${SESSION}/upload-init`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
    );
    expect(r.status).toBe(400);
  });
});

describe("upload-commit", () => {
  const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

  test("commit 成功返回本地路径", async () => {
    const { app, calls } = harness({
      respond: () => json({ path: "/home/u/Pictures/tmux-hub/2026-08-10/x.png", size: 10 }),
    });
    const r = await app.fetch(post(`/sessions/${SESSION}/upload-commit`, { uploadId: UUID }));
    expect(r.status).toBe(200);
    expect((await r.json() as any).path).toBe("/home/u/Pictures/tmux-hub/2026-08-10/x.png");
    expect(calls[0]!.url).toBe(`http://127.0.0.1:8105/v1/uploads/${UUID}/commit`);
  });

  test("uploadId 必须是 UUID 形状——不让任意串拼进 broker 的 URL 路径", async () => {
    const { app, calls } = harness();
    for (const bad of ["../../v1/healthz", "x", "", "a/b", "3f2504e0-4f89-11d3-9a0c-0305e82c33zz"]) {
      const r = await app.fetch(post(`/sessions/${SESSION}/upload-commit`, { uploadId: bad }));
      expect(r.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  test("broker 的 409（已消费）原样透传", async () => {
    const { app } = harness({ respond: () => json({ error: "consumed", code: "consumed" }, 409) });
    const r = await app.fetch(post(`/sessions/${SESSION}/upload-commit`, { uploadId: UUID }));
    expect(r.status).toBe(409);
  });

  test("会话不存在 → 410", async () => {
    const { app, calls } = harness();
    const r = await app.fetch(post(`/sessions/user-gone-9/upload-commit`, { uploadId: UUID }));
    expect(r.status).toBe(410);
    expect(calls).toHaveLength(0);
  });

  test("broker 未启用 → 501", async () => {
    const { app } = harness({ enabled: false });
    const r = await app.fetch(post(`/sessions/${SESSION}/upload-commit`, { uploadId: UUID }));
    expect(r.status).toBe(501);
  });
});
