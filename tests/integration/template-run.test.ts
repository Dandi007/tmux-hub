import { describe, test, expect, afterEach, afterAll } from "bun:test";
import { tmuxTest, tmuxTestKillServer } from "../helpers/tmux-test";
import { TemplateRunner, TemplateError } from "../../src/server/template-runner";
import type { Template } from "../../src/server/config";

const T: Template[] = [
  { id: "shell", name: "shell", cwd_choices: ["/tmp"], cmd: "sleep 30" },
];

const created: string[] = [];

afterEach(async () => {
  for (const n of created) {
    await tmuxTest(["kill-session", "-t", n]).catch(() => {});
  }
  created.length = 0;
});

afterAll(async () => {
  await tmuxTestKillServer();
});

describe("TemplateRunner", () => {
  test("starts session with allowed cwd", async () => {
    const r = new TemplateRunner(T, tmuxTest);
    const name = await r.run("shell", "/tmp");
    created.push(name);
    expect(name).toMatch(/^shell-\d{14}$/);
    const list = await tmuxTest(["list-sessions", "-F", "#{session_name}"]);
    expect(list.stdout.split("\n")).toContain(name);
  });

  test("rejects cwd not in choices (400)", async () => {
    const r = new TemplateRunner(T, tmuxTest);
    try {
      await r.run("shell", "/etc");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(TemplateError);
      expect((e as TemplateError).status).toBe(400);
    }
  });

  test("rejects unknown template id (404)", async () => {
    const r = new TemplateRunner(T, tmuxTest);
    try {
      await r.run("not-real", "/tmp");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as TemplateError).status).toBe(404);
    }
  });

  test("rejects non-existent cwd (400)", async () => {
    const T2: Template[] = [{ id: "shell", name: "s", cwd_choices: ["/this/path/does/not/exist"], cmd: "sleep 30" }];
    const r = new TemplateRunner(T2, tmuxTest);
    try {
      await r.run("shell", "/this/path/does/not/exist");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as TemplateError).status).toBe(400);
    }
  });

  test("propagates env vars to tmux new-session", async () => {
    const r = new TemplateRunner(T, tmuxTest);
    const name = await r.run("shell", "/tmp", { FOO: "bar", PROMPT_PATH: "/etc/hosts" });
    created.push(name);
    const foo = await tmuxTest(["show-environment", "-t", name, "FOO"]);
    expect(foo.stdout.trim()).toBe("FOO=bar");
    const pp = await tmuxTest(["show-environment", "-t", name, "PROMPT_PATH"]);
    expect(pp.stdout.trim()).toBe("PROMPT_PATH=/etc/hosts");
  });

  test("rejects invalid env var name (400)", async () => {
    const r = new TemplateRunner(T, tmuxTest);
    try {
      await r.run("shell", "/tmp", { "bad name": "x" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as TemplateError).status).toBe(400);
    }
  });

  test("rejects env var value containing NUL (400)", async () => {
    const r = new TemplateRunner(T, tmuxTest);
    try {
      await r.run("shell", "/tmp", { OK: "a\0b" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as TemplateError).status).toBe(400);
    }
  });
});
