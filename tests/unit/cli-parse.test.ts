import { describe, test, expect } from "bun:test";
import { parseLaunchArgs } from "../../src/server/cli";

describe("parseLaunchArgs", () => {
  test("parses minimal args: launch --cwd /tmp -- echo hello", () => {
    const r = parseLaunchArgs(["launch", "--cwd", "/tmp", "--", "echo", "hello"]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value).toEqual({ cwd: "/tmp", cmd: "echo hello", env: {} });
  });

  test("parses --cwd=value form", () => {
    const r = parseLaunchArgs(["launch", "--cwd=/tmp", "--", "ls"]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.cwd).toBe("/tmp");
    expect(r.value.cmd).toBe("ls");
  });

  test("parses --name", () => {
    const r = parseLaunchArgs(["launch", "--cwd", "/tmp", "--name", "my-session", "--", "sleep", "30"]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.name).toBe("my-session");
    expect(r.value.cmd).toBe("sleep 30");
  });

  test("parses --name=value form", () => {
    const r = parseLaunchArgs(["launch", "--cwd=/tmp", "--name=my-session", "--", "ls"]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.name).toBe("my-session");
  });

  test("parses --env KEY=VAL", () => {
    const r = parseLaunchArgs(["launch", "--cwd", "/tmp", "--env", "FOO=bar", "--", "sleep", "30"]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.env).toEqual({ FOO: "bar" });
  });

  test("parses --env=KEY=VAL form", () => {
    const r = parseLaunchArgs(["launch", "--cwd=/tmp", "--env=BAZ=qux", "--", "ls"]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.env).toEqual({ BAZ: "qux" });
  });

  test("parses multiple --env", () => {
    const r = parseLaunchArgs(["launch", "--cwd", "/tmp", "--env", "A=1", "--env", "B=2", "--", "cmd"]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.env).toEqual({ A: "1", B: "2" });
  });

  test("parses multi-word command", () => {
    const r = parseLaunchArgs(["launch", "--cwd", "/tmp", "--", "bash", "-c", "echo hello world"]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.cmd).toBe("bash -c echo hello world");
  });

  test("rejects missing launch subcommand", () => {
    const r = parseLaunchArgs(["--cwd", "/tmp", "--", "ls"]);
    expect(r.ok).toBe(false);
  });

  test("rejects missing -- before command", () => {
    const r = parseLaunchArgs(["launch", "--cwd", "/tmp", "ls"]);
    expect(r.ok).toBe(false);
  });

  test("rejects missing command after --", () => {
    const r = parseLaunchArgs(["launch", "--cwd", "/tmp", "--"]);
    expect(r.ok).toBe(false);
  });

  test("rejects missing --cwd", () => {
    const r = parseLaunchArgs(["launch", "--", "ls"]);
    expect(r.ok).toBe(false);
  });

  test("rejects unknown flag", () => {
    const r = parseLaunchArgs(["launch", "--cwd", "/tmp", "--unknown", "--", "ls"]);
    expect(r.ok).toBe(false);
  });

  test("rejects --env without value", () => {
    const r = parseLaunchArgs(["launch", "--cwd", "/tmp", "--env", "--", "ls"]);
    expect(r.ok).toBe(false);
  });

  test("rejects --env with bad format", () => {
    const r = parseLaunchArgs(["launch", "--cwd", "/tmp", "--env", "NOKEY", "--", "ls"]);
    expect(r.ok).toBe(false);
  });

  test("name defaults to undefined when not set", () => {
    const r = parseLaunchArgs(["launch", "--cwd", "/tmp", "--", "ls"]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.name).toBeUndefined();
  });

  test("env defaults to empty when not set", () => {
    const r = parseLaunchArgs(["launch", "--cwd", "/tmp", "--", "ls"]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.env).toEqual({});
  });
});