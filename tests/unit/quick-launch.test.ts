import { describe, test, expect, mock } from "bun:test";
import { runQuickLaunch } from "../../src/web/mobile/quick-launch";

describe("runQuickLaunch", () => {
  test("200 OK → onStarted called with returned name; no error callback", async () => {
    const fetcher = mock(async () => new Response(JSON.stringify({ name: "kb-cc-20260523010000" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const onStarted = mock(() => {});
    const onError = mock(() => {});

    await runQuickLaunch({ fetcher, cwd: "~", onStarted, onError });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/templates/kb-cc/run");
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ cwd: "~" }));
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(onStarted.mock.calls[0]?.[0]).toBe("kb-cc-20260523010000");
    expect(onError).not.toHaveBeenCalled();
  });
});
