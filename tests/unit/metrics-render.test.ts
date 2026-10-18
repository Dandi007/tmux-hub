import { describe, test, expect } from "bun:test";
import { renderMetrics, openFdCount } from "../../src/server/metrics";

describe("renderMetrics", () => {
  test("always starts with tmux_hub_up 1 and renders gauges in Prometheus text format", () => {
    const out = renderMetrics([{ name: "foo_bytes", help: "Foo.", value: () => 42 }]);
    expect(out.split("\n")[0]).toBe("tmux_hub_up 1");
    expect(out).toContain("# HELP foo_bytes Foo.\n# TYPE foo_bytes gauge\nfoo_bytes 42\n");
    expect(out.endsWith("\n")).toBe(true);
  });

  test("renders counters with TYPE counter", () => {
    const out = renderMetrics([{ name: "foo_total", help: "Foo.", type: "counter", value: () => 3 }]);
    expect(out).toContain("# HELP foo_total Foo.\n# TYPE foo_total counter\nfoo_total 3\n");
  });

  test("omits gauges that throw or return undefined", () => {
    const out = renderMetrics([
      { name: "bad", help: "x", value: () => { throw new Error("boom"); } },
      { name: "none", help: "x", value: () => undefined },
      { name: "ok", help: "x", value: () => 1 },
    ]);
    expect(out).not.toContain("bad");
    expect(out).not.toContain("none");
    expect(out).toContain("ok 1");
  });
});

describe("openFdCount", () => {
  test("counts /proc/self/fd on Linux, undefined elsewhere", () => {
    const n = openFdCount();
    if (process.platform === "linux") expect(n).toBeGreaterThan(0);
    else expect(n).toBeUndefined();
  });
});
