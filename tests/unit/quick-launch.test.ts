import { describe, test, expect, mock } from "bun:test";
import { runQuickLaunch } from "../../src/web/shared/quick-launch";

describe("runQuickLaunch", () => {
  test("200 OK → onStarted called with returned name; no error callback", async () => {
    const fetcher = mock(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify({ name: "kb-cc-20260523010000" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const onStarted = mock((_name: string) => {});
    const onError = mock((_kind: "not-configured" | "runtime", _message: string) => {});

    await runQuickLaunch({ fetcher, templateId: "kb-cc", cwd: "~", onStarted, onError });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/templates/kb-cc/run");
    const init = fetcher.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ cwd: "~" }));
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(onStarted.mock.calls[0]?.[0]).toBe("kb-cc-20260523010000");
    expect(onError).not.toHaveBeenCalled();
  });

  test("404 → onError('not-configured'); no onStarted", async () => {
    const fetcher = mock(async (_input: string, _init?: RequestInit) => new Response("template not found: kb-cc", { status: 404 }));
    const onStarted = mock((_name: string) => {});
    const onError = mock((_kind: "not-configured" | "runtime", _message: string) => {});

    await runQuickLaunch({ fetcher, templateId: "kb-cc", cwd: "~", onStarted, onError });

    expect(onStarted).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe("not-configured");
    expect(onError.mock.calls[0]?.[1]).toContain("kb-cc");
  });

  test("500 → onError('runtime', body text)", async () => {
    const fetcher = mock(async (_input: string, _init?: RequestInit) => new Response("internal boom", { status: 500 }));
    const onStarted = mock((_name: string) => {});
    const onError = mock((_kind: "not-configured" | "runtime", _message: string) => {});

    await runQuickLaunch({ fetcher, templateId: "kb-cc", cwd: "~", onStarted, onError });

    expect(onStarted).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe("runtime");
    expect(onError.mock.calls[0]?.[1]).toBe("internal boom");
  });

  test("network error (fetcher throws) → onError('runtime', message)", async () => {
    const fetcher = mock(async (_input: string, _init?: RequestInit) => { throw new Error("network down"); });
    const onStarted = mock((_name: string) => {});
    const onError = mock((_kind: "not-configured" | "runtime", _message: string) => {});

    await runQuickLaunch({ fetcher, templateId: "kb-cc", cwd: "~", onStarted, onError });

    expect(onStarted).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe("runtime");
    expect(onError.mock.calls[0]?.[1]).toBe("network down");
  });

  test("200 with malformed body → onError('runtime', 'malformed response')", async () => {
    const fetcher = mock(async (_input: string, _init?: RequestInit) => new Response("<not-json>", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const onStarted = mock((_name: string) => {});
    const onError = mock((_kind: "not-configured" | "runtime", _message: string) => {});

    await runQuickLaunch({ fetcher, templateId: "kb-cc", cwd: "~", onStarted, onError });

    expect(onStarted).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe("runtime");
    expect(onError.mock.calls[0]?.[1]).toBe("malformed response");
  });

  test("templateId is reflected in the POST path", async () => {
    const fetcher = mock(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify({ name: "shell-20260623010000" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const onStarted = mock((_name: string) => {});
    const onError = mock((_kind: "not-configured" | "runtime", _message: string) => {});

    await runQuickLaunch({ fetcher, templateId: "shell", cwd: "~", onStarted, onError });

    expect(fetcher.mock.calls[0]?.[0]).toBe("/templates/shell/run");
    expect(onStarted).toHaveBeenCalledTimes(1);
  });
});
