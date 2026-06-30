// Client-side render telemetry, opt-in via `?debug=perf`.
//
// Goal: quantify what the USER actually experiences on their device, instead of
// inferring it server-side. The jank the user reports is about REFRESH INTERVAL
// (the gap between successive paints), not raw latency — a steady stream that
// repaints every 2s feels broken even if each frame's transit latency is small.
//
// So we measure, per 1s window, BOTH:
//   - data-arrival interval  (gap between ws output chunks)   → producer cadence
//   - render interval        (gap between xterm `onRender`)   → what the eye sees
// If data arrives every ~200ms but render gaps spike to seconds, the bottleneck
// is client-side painting (canvas/DOM cost, rAF throttling), not the hub.
//
// Each sample is shipped back over the existing terminal WS as
// `{ kind: "telemetry", payload }` and logged by the server, so the operator can
// read real per-device numbers from the hub logs.

export type PerfSink = (payload: Record<string, unknown>) => void;

/** True when the page was opened with `?debug=perf` (comma-list aware). */
export function perfEnabled(): boolean {
  try {
    const v = new URLSearchParams(location.search).get("debug") ?? "";
    return v.split(",").map((s) => s.trim()).includes("perf");
  } catch {
    return false;
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx]!;
}

export interface PerfTelemetry {
  /** Called for each terminal data chunk written to xterm (bytes + sync parse cost). */
  recordData(bytes: number, parseMs: number): void;
  /** Record which renderer actually loaded (canvas is fast, DOM fallback is slow). */
  setRenderer(renderer: "canvas" | "dom"): void;
  /** Subscribe to xterm paints to measure render cadence. */
  attach(term: { onRender: (cb: () => void) => void; cols: number; rows: number }): void;
  stop(): void;
}

export function createPerfTelemetry(sessionName: string, sink: PerfSink): PerfTelemetry {
  let frames = 0; // ws data chunks in this window
  let bytes = 0;
  let renders = 0; // xterm paints in this window
  let parseMax = 0;
  let dataToPaintMax = 0;
  const wsGaps: number[] = [];
  const renderGaps: number[] = [];
  let lastWsTs = 0;
  let lastRenderTs = 0;
  let pendingSince = 0; // ts of most recent data still awaiting a paint
  let renderer: "canvas" | "dom" = "dom";
  let termRef: { cols: number; rows: number } | null = null;

  const now = (): number => performance.now();

  const flush = (): void => {
    if (frames === 0 && renders === 0) return;
    sink({
      kind: "perf",
      session: sessionName,
      t: Date.now(),
      cols: termRef?.cols ?? 0,
      rows: termRef?.rows ?? 0,
      renderer,
      frames, // data chunks/s arriving from the hub
      bytes,
      renders, // paints/s actually drawn
      // ── the interval metrics (jank = large render gaps) ──
      wsGapP50: Math.round(percentile(wsGaps, 0.5)),
      wsGapMax: Math.round(percentile(wsGaps, 1)),
      renderGapP50: Math.round(percentile(renderGaps, 0.5)),
      renderGapMax: Math.round(percentile(renderGaps, 1)),
      // ── latency / cost ──
      dataToPaintMax: Math.round(dataToPaintMax),
      parseMaxMs: Math.round(parseMax * 10) / 10,
      dpr: window.devicePixelRatio || 1,
      ua: navigator.userAgent.slice(0, 90),
    });
    frames = 0;
    bytes = 0;
    renders = 0;
    parseMax = 0;
    dataToPaintMax = 0;
    wsGaps.length = 0;
    renderGaps.length = 0;
  };

  const timer = setInterval(flush, 1000);

  return {
    recordData(b, parseMs) {
      const t = now();
      if (lastWsTs) wsGaps.push(t - lastWsTs);
      lastWsTs = t;
      frames += 1;
      bytes += b;
      if (parseMs > parseMax) parseMax = parseMs;
      pendingSince = t;
    },
    setRenderer(r) {
      renderer = r;
    },
    attach(term) {
      termRef = term;
      term.onRender(() => {
        const t = now();
        renders += 1;
        if (lastRenderTs) renderGaps.push(t - lastRenderTs);
        lastRenderTs = t;
        if (pendingSince) {
          const d = t - pendingSince;
          if (d > dataToPaintMax) dataToPaintMax = d;
          pendingSince = 0;
        }
      });
    },
    stop() {
      clearInterval(timer);
    },
  };
}
