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

  test("large literal produces multiple send-keys calls", async () => {
    const calls: string[][] = [];
    const spy = async (args: string[]) => {
      calls.push(args);
      return { stdout: "", stderr: "", code: 0 };
    };
    const r = new InputRouter(spy);
    await r.send(S, { kind: "keys", literal: "a".repeat(3000) });
    const skCalls = calls.filter((c) => c[0] === "send-keys");
    expect(skCalls.length).toBe(3);
    for (const c of skCalls) {
      expect(Buffer.byteLength(c[4]!)).toBeLessThanOrEqual(1024);
    }
  });

  test("resize calls tmux resize-window", async () => {
    const calls: string[][] = [];
    const spy = async (args: string[]) => {
      calls.push(args);
      return { stdout: "", stderr: "", code: 0 };
    };
    const r = new InputRouter(spy);
    await r.send(S, { kind: "resize", cols: 180, rows: 42 });
    const resizeCall = calls.find((c) => c[0] === "resize-window");
    expect(resizeCall).toEqual(["resize-window", "-t", `${S}:0`, "-x", "180", "-y", "42"]);
  });

  test("large literal is chunked and fully delivered", async () => {
    const r = new InputRouter(tmuxTest);
    const marker = "CHUNK_OK_" + Date.now();
    const padding = "x".repeat(3000);
    const payload = `echo ${marker}${padding}`;
    await r.send(S, { kind: "keys", literal: payload });
    await r.send(S, { kind: "key", name: "Enter" });
    await new Promise((res) => setTimeout(res, 500));
    const cap = await tmuxTest(["capture-pane", "-p", "-t", `${S}:@0.0`]);
    expect(cap.stdout).toContain(marker);
  });

  test("resize clamps to bounds", async () => {
    const calls: string[][] = [];
    const spy = async (args: string[]) => {
      calls.push(args);
      return { stdout: "", stderr: "", code: 0 };
    };
    const r = new InputRouter(spy);
    await r.send(S, { kind: "resize", cols: 9999, rows: 9999 });
    expect(calls.find((c) => c[0] === "resize-window")).toEqual(
      ["resize-window", "-t", `${S}:0`, "-x", "500", "-y", "200"],
    );
  });
});
