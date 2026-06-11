import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { authGate, _resetSecretForTest } from "../../src/server/auth";

// Regression guard for the mobile-TUI "press Enter on a template does nothing"
// bug: the TUI launches a template via POST /templates/:id/run, a route gated by
// the standard authGate (x-hub-secret / cf-access), NOT the admin gate. The CLI
// previously authenticated this POST with x-hub-admin-secret — the wrong
// credential — so authGate returned 401 and no session was ever created.
//
// This test mounts the REAL authGate over a stub /templates route and drives the
// actual CLI binary against it. Before the fix the CLI sends x-hub-admin-secret
// and the run fails (non-zero exit); after the fix it sends x-hub-secret and the
// run succeeds.

const BIN = join(import.meta.dir, "../../bin/tmux-hub");
const TMP = mkdtempSync(join(tmpdir(), "tui-template-auth-"));

const HUB_SECRET = "hub-secret-for-tui-template-auth-test-0123456789abcdef";
const SECRET_PATH = join(TMP, "hub.secret");
const ADMIN_SECRET_PATH = join(TMP, "hub.admin.secret");
const DB_PATH = join(TMP, "managed-sessions.db");
writeFileSync(SECRET_PATH, HUB_SECRET);
writeFileSync(ADMIN_SECRET_PATH, "admin-secret-distinct-from-hub-secret-abcdef0123456789");

// authGate (in this test process) must validate against the same hub.secret file
// the spawned CLI reads.
process.env.TMUX_HUB_SECRET_PATH = SECRET_PATH;

let server: ReturnType<typeof Bun.serve> | null = null;
let port = 0;
let runHeaders: Record<string, string> = {};

beforeAll(() => {
  _resetSecretForTest();
  const app = new Hono();
  app.use("*", authGate); // the real global gate, exactly as main.ts mounts it

  app.get("/templates", (c) =>
    c.json([{ id: "shell", name: "shell", cwd_choices: ["/tmp"] }]),
  );

  app.post("/templates/:id/run", async (c) => {
    // Record the headers authGate let through so we can assert the credential.
    runHeaders = Object.fromEntries(c.req.raw.headers.entries());
    return c.json({ name: "shell-00000000000000" }, 201);
  });

  server = Bun.serve({ port: 0, fetch: app.fetch });
  port = server.port ?? 0;
});

afterAll(() => {
  server?.stop(true);
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

async function cli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TMUX_HUB_PORT: String(port),
    TMUX_HUB_SECRET_PATH: SECRET_PATH,
    TMUX_HUB_ADMIN_SECRET_PATH: ADMIN_SECRET_PATH,
    TMUX_HUB_DB_PATH: DB_PATH,
    TMUX: "", // run outside tmux so --print-cmd emits attach-session
  };
  const proc = Bun.spawn(["bun", BIN, ...args], { stdout: "pipe", stderr: "pipe", env });
  const stdout = (await new Response(proc.stdout).text()).trim();
  const stderr = (await new Response(proc.stderr).text()).trim();
  const code = await proc.exited;
  return { stdout, stderr, code };
}

describe("TUI template run authenticates against authGate", () => {
  test("--select-template succeeds (POST is authenticated, not 401)", async () => {
    const { stdout, stderr, code } = await cli(["tui", "--select-template", "shell", "--print-cmd"]);
    expect(stderr).not.toContain("unauthorized");
    expect(code).toBe(0);
    // --print-cmd prints the attach command for the created session
    expect(stdout).toContain("attach-session");
    expect(stdout).toContain("shell-00000000000000");
  });

  test("the run POST carries x-hub-secret, not x-hub-admin-secret", async () => {
    runHeaders = {};
    const { code } = await cli(["tui", "--select-template", "shell", "--print-cmd"]);
    expect(code).toBe(0);
    expect(runHeaders["x-hub-secret"]).toBe(HUB_SECRET);
    expect(runHeaders["x-hub-admin-secret"]).toBeUndefined();
  });
});
