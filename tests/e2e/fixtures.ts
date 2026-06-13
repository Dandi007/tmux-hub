import { test as base, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Ctx = {
  socket: string;
  tmuxTmpdir: string;
  port: string;
  /** Run a raw tmux command against the isolated e2e server — for test
   * instrumentation only (capture-pane / send-keys / list-sessions / kill). */
  tmuxE2E: (args: string[]) => string;
  /**
   * Create a session the way a real user does — through the hub's managed
   * launch path (`POST /templates/:id/run`). Returns the server-assigned
   * session name (`<templateId>-<ts14>`).
   *
   * This is the ONLY correct way to make a session the hub will surface: the
   * registry only shows names recorded in its managed db, so a raw
   * `tmux new-session` is invisible to every client. Side-loading raw sessions
   * is exactly what rotted the legacy e2e suite.
   */
  createSession: (templateId?: string) => Promise<string>;
};

type E2EEnv = {
  socket: string;
  tmuxTmpdir: string;
  secretPath: string;
  port: string;
};

function loadE2EEnv(): E2EEnv {
  const cwdHash = Buffer.from(process.cwd()).toString("base64url").slice(0, 12);
  const envFile = process.env.TMUX_HUB_E2E_ENV_FILE ?? join(tmpdir(), `tmux-hub-e2e-env-${cwdHash}.json`);
  if (!existsSync(envFile)) {
    throw new Error(`E2E env file not found at ${envFile} — run via playwright.config.ts`);
  }
  return JSON.parse(readFileSync(envFile, "utf8")) as E2EEnv;
}

export const test = base.extend<{ ctx: Ctx }>({
  ctx: async ({}, use) => {
    const { socket, tmuxTmpdir, port } = loadE2EEnv();
    if (!existsSync(tmuxTmpdir)) mkdirSync(tmuxTmpdir, { recursive: true });

    const env = { ...process.env, TMUX_TMPDIR: tmuxTmpdir };
    const tmuxE2E = (args: string[]): string => {
      const r = spawnSync("tmux", ["-L", socket, ...args], { env, encoding: "utf8" });
      if (r.status !== 0) {
        if (!/no server|no sessions|can't find/i.test(r.stderr ?? "")) {
          throw new Error(`tmux -L ${socket} ${args.join(" ")} failed (${r.status}): ${r.stderr}`);
        }
      }
      return (r.stdout ?? "").trimEnd();
    };

    const baseUrl = `http://127.0.0.1:${port}`;
    let secret: string | null = null;
    const getSecret = async (): Promise<string> => {
      if (secret) return secret;
      const r = await fetch(`${baseUrl}/system/auth-check`);
      if (!r.ok) throw new Error(`/system/auth-check returned ${r.status}`);
      const body = (await r.json()) as { secret?: string };
      if (!body.secret) throw new Error("/system/auth-check did not return a secret (dev-bind off?)");
      secret = body.secret;
      return secret;
    };

    const createSession = async (templateId = "shell"): Promise<string> => {
      const s = await getSecret();
      const url = `${baseUrl}/templates/${encodeURIComponent(templateId)}/run`;
      // The managed name is `<id>-<ts14>` at second resolution, so two creates
      // landing in the same wall-clock second collide (409). Retry past the
      // second boundary instead of forcing callers to space their fixtures.
      for (let attempt = 0; attempt < 5; attempt++) {
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-hub-secret": s },
          body: JSON.stringify({ cwd: "~" }),
        });
        if (r.status === 201) {
          const body = (await r.json()) as { name?: string };
          if (!body.name) throw new Error(`createSession(${templateId}): 201 without name`);
          return body.name;
        }
        if (r.status === 409) {
          await new Promise((res) => setTimeout(res, 1100));
          continue;
        }
        const text = await r.text().catch(() => "");
        throw new Error(`createSession(${templateId}) failed: HTTP ${r.status} ${text}`);
      }
      throw new Error(`createSession(${templateId}) failed: name kept colliding (409)`);
    };

    await use({ socket, tmuxTmpdir, port, tmuxE2E, createSession });
  },
});

export { expect };
