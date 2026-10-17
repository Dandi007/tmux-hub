import { describe, test, expect } from "bun:test";
import { parseMetrics, judgeSoak, screenDiff } from "../../scripts/diag/soak-judge";

const text = (o: Record<string, number>) =>
  "tmux_hub_up 1\n" + Object.entries(o).map(([k, v]) => `# HELP ${k} x\n# TYPE ${k} gauge\n${k} ${v}`).join("\n") + "\n";

const base = {
  process_open_fds: 24, tmux_hub_ws_connections: 0, tmux_hub_sse_clients: 0,
  tmux_hub_broadcaster_subscribers: 0, tmux_hub_broadcasters: 2, tmux_hub_sessions: 2,
};

describe("parseMetrics", () => {
  test("reads gauge values and skips comments", () => {
    expect(parseMetrics(text({ a_b: 3, process_open_fds: 24 }))).toEqual({ tmux_hub_up: 1, a_b: 3, process_open_fds: 24 });
  });
});

describe("judgeSoak", () => {
  test("clean when every lifecycle gauge returns to baseline", () => {
    expect(judgeSoak(base, { ...base })).toEqual([]);
  });

  test("flags leaked websockets, SSE clients, subscribers and fds", () => {
    const end = { ...base, tmux_hub_ws_connections: 1, tmux_hub_sse_clients: 2, tmux_hub_broadcaster_subscribers: 3, process_open_fds: 40 };
    const problems = judgeSoak(base, end).join("\n");
    expect(problems).toContain("tmux_hub_ws_connections");
    expect(problems).toContain("tmux_hub_sse_clients");
    expect(problems).toContain("tmux_hub_broadcaster_subscribers");
    expect(problems).toContain("process_open_fds");
  });

  test("tolerates small fd jitter but not drift", () => {
    expect(judgeSoak(base, { ...base, process_open_fds: 26 })).toEqual([]);
    expect(judgeSoak(base, { ...base, process_open_fds: 30 })).not.toEqual([]);
  });

  test("broadcasters must still match sessions", () => {
    expect(judgeSoak(base, { ...base, tmux_hub_broadcasters: 5 }).join()).toContain("tmux_hub_broadcasters");
  });

  test("missing gauge is reported, not silently passed", () => {
    const { tmux_hub_sse_clients: _, ...end } = base;
    expect(judgeSoak(base, end).join()).toContain("tmux_hub_sse_clients");
  });
});

describe("screenDiff", () => {
  test("equal screens modulo trailing blanks and blank tail rows", () => {
    expect(screenDiff(["a  ", "b", ""], ["a", "b"])).toBe(0);
  });
  test("counts differing rows on either side", () => {
    expect(screenDiff(["a", "x", "c"], ["a", "b", "c"])).toBe(1);
    expect(screenDiff(["a", "b", "extra"], ["a", "b"])).toBe(1);
    expect(screenDiff(["a"], ["a", "b", "c"])).toBe(2);
  });
});
