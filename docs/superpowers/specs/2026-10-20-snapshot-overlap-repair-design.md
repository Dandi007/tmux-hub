# Busy snapshot recovery

## 1 第一性原理：要什么

A browser reconnecting to a terminal that continuously redraws must receive its
first screen without unbounded waiting. If that screen overlaps live bytes, the
browser must converge to tmux automatically after output stops, without another
manual reconnect. Preserve a scrolled-up viewport and cancel work on disconnect.

## 2 现状与根因

RSI round 19 reproduced persistent differences in 9/12 dogfood trials on df45b48.
`attachWithReplay` tries five captures with a 30ms settle window, then sends the
last snapshot plus pending bytes even if those bytes were already rendered by
tmux. The overlap can duplicate relative cursor movements. There is no repair
until a subsequent attach or resize. Static reconnect healed all nine failures.

## 3 方案设计

```
attach / resize -> bounded snapshot -> overlap callback
                                      |
                              per-connection repair pending
                                      |
                   output quiet >=100ms -> serialized resync
                                      |
                       existing resync + scrollpos protocol
```

Keep the five-capture first-screen limit. Add an optional per-attach callback
when it falls back with overlapping bytes; only clients supporting resync use it.
The broadcaster records the time of the last emitted bytes and exposes a quiet
check. Extend the existing per-connection ResyncScheduler with a repair request:
check for quiet every 100ms without issuing captures while output is busy, then
serialize the repair behind initial attach and resize work. Resize and repair
share the current pane dimensions. A repair that itself overlaps schedules
another quiet check. A successful resize also satisfies an outstanding repair.
Dispose cancels pending repair timers; queued work checks disposal. Use the
existing resync announcement and trailing scrollpos message, so client scroll
restoration and hidden pool slot behavior stay consistent. No protocol change.

## 4 改动清单

- `src/server/output-broadcaster.ts`: last-output timestamp, quiet check,
  overlap callback on attach and resync.
- `src/server/resize-resync.ts`: quiet recovery requests, serialized captures,
  cancellation and coalescing with resize.
- `src/server/ws-handlers.ts`: wire per-connection recovery and replay completion.
- `tests/unit/resize-resync.test.ts`: quiet gating, attach/resize serialization,
  repeat recovery, cancellation.
- `tests/integration/broadcaster-overlap.test.ts`: deterministic forced overlap
  notification, quiet detection, bounded capture count.
- `playwright.config.ts`: keep E2E uploaded images under the isolated tmux
  temporary root, instead of the runtime HOME; retain every existing test.
- `tests/unit/image-dir.test.ts`: isolate child-process logger files after
  scrubbing hub configuration; keep all config assertions unchanged. Full-suite
  native validation exposed writes to the read-only runtime HOME.
- `tests/e2e/fidelity-suite.ts`: continuously redraw during reconnect, stop after
  overlap, require automatic convergence and scroll preservation.

## 5 测试计划与验收

First run the new regressions against existing code and save failures. Run build,
test lint, all unit/integration tests, desktop and emulator E2E on isolated tmux
sockets with inherited hub variables removed. Review patch, require both PR and
merged-main push CI success before dogfood deployment. On dogfood replay round
19's 12 forced-overlap scenarios without healing by a manual second reconnect;
all final screens must converge. Check screenshot and cleanup metrics. No prod
operations, accepted movement, voice changes, or harness edits.

## 6 非目标与限制

This repairs eventual screen fidelity; it does not claim byte-exact snapshots
while tmux is changing continuously. No change to retry limits, log rotation,
legacy replay, or old clients without resync support. A permanently busy pane
can retain a repair request until it becomes quiet; polling issues no capture
commands during that period.
