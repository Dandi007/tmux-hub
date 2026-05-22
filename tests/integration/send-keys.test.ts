import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { tmuxTest, tmuxTestKillServer } from "../helpers/tmux-test";
import { InputRouter, HubError } from "../../src/server/input-router";

const S = "user-sk-" + Date.now().toString().slice(-8);

beforeAll(async () => {
  await tmuxTest(["new-session", "-d", "-s", S, "-x", "200", "-y", "50", "sh"]);
});

afterAll(async () => {
  await tmuxTest(["kill-session", "-t", S]).catch(() => {});
  await tmuxTestKillServer();
});

describe("InputRouter", () => {
  test("literal + Enter reaches the pane", async () => {
    const r = new InputRouter(tmuxTest);
    await r.send(S, { kind: "keys", literal: "echo HELLO_INPUT" });
    await r.send(S, { kind: "key", name: "Enter" });
    await new Promise((res) => setTimeout(res, 300));
    const cap = await tmuxTest(["capture-pane", "-p", "-t", `${S}:@0.0`]);
    expect(cap.stdout).toContain("HELLO_INPUT");
  });

  test("unknown key rejected with HubError(400)", async () => {
    const r = new InputRouter(tmuxTest);
    let err: HubError | null = null;
    try { await r.send(S, { kind: "key", name: "X-not-real" }); }
    catch (e) { err = e as HubError; }
    expect(err).toBeInstanceOf(HubError);
    expect(err?.code).toBe(400);
  });

  test("missing session rejected with HubError(410)", async () => {
    const r = new InputRouter(tmuxTest);
    let err: HubError | null = null;
    try { await r.send("user-nosuch-99999999", { kind: "key", name: "Enter" }); }
    catch (e) { err = e as HubError; }
    expect(err?.code).toBe(410);
  });

  test("session name grammar violation rejected before tmux call", async () => {
    const r = new InputRouter(tmuxTest);
    await expect(r.send("Bad.Name!", { kind: "key", name: "Enter" })).rejects.toThrow();
  });

  test("resize is no-op (does not throw)", async () => {
    const r = new InputRouter(tmuxTest);
    await r.send(S, { kind: "resize", cols: 200, rows: 50 });
    // no expectation other than not throwing
  });
});
