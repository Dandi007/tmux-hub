import { readdirSync } from "node:fs";

export interface Gauge {
  name: string;
  help: string;
  value: () => number | undefined;
  // Default gauge; a counter only ever grows (Prometheus `_total`).
  type?: "gauge" | "counter";
}

// Prometheus text format. A gauge whose reader throws or yields undefined is
// omitted, so /metrics never 5xxes on a data-plane hiccup; `tmux_hub_up 1`
// always leads.
export function renderMetrics(gauges: Gauge[]): string {
  let out = "tmux_hub_up 1\n";
  for (const g of gauges) {
    let v: number | undefined;
    try { v = g.value(); } catch { continue; }
    if (v === undefined || !Number.isFinite(v)) continue;
    out += `# HELP ${g.name} ${g.help}\n# TYPE ${g.name} ${g.type ?? "gauge"}\n${g.name} ${v}\n`;
  }
  return out;
}

// Linux only (/proc); macOS prod gets undefined and the gauge is omitted.
export function openFdCount(): number | undefined {
  if (process.platform !== "linux") return undefined;
  return readdirSync("/proc/self/fd").length;
}
