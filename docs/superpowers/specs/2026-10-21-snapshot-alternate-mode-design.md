# Preserve alternate screen across ordinary snapshots

## 1. User behavior and constraints
Reconnecting to a running full-screen application must keep its alternate screen active: wheel navigation must not reveal normal-screen history. Exiting the application must restore the saved normal screen, history and cursor. Desktop and phone must behave the same, including a broadcaster started after the application entered alternate mode. Keep explicit normal-history navigation and following behavior intact.

## 2. Current behavior and root cause
Deployed e07e0c8 reproduces on desktop and phone: tmux alternate_on=1, but after ordinary capture-pane replay wheel navigation changes linesFromBottom from 0 to 25 and displays prior history. captureSnapshot emits RIS, history and active screen text without entering alternate mode. The emulator fallback serializes this mode, but the ordinary path does not. ModeShadow alone cannot solve cold attach after startup because it has not necessarily observed the entry sequence. The separate weak-background obsolete-history failure remains under investigation; no common cause is assumed.

## 3. Design
Read alternate_on and the saved normal cursor together with pane geometry inside the existing alignment window. When alternate is active, capture the saved normal screen with tmux capture-pane -a, build its history and visible grid, position its saved cursor, then enter alternate mode before painting the active capture and restoring modes/current cursor. Read history without -a: real tmux exposes normal history above the active grid, while -a exposes only the saved normal visible screen and has no history. Preserve the existing ordinary normal path and retry/overlap alignment. A failed saved-screen capture uses the existing logged emulator fallback; never force fallback to hide an ordinary-path defect. No protocol change.

## 4. Files
- src/server/output-broadcaster.ts: mode-aware geometry and normal/alternate replay composition.
- tests/integration/snapshot-screen-fidelity.test.ts: real tmux cold alternate attach, history, cursor and live exit behavior.
- tests/e2e/fidelity-alternate.ts and fidelity-suite.ts: desktop/phone actual wheel, reconnect, resize, exit and normal-history navigation.
- AGENTS.md: spec link.

## 5. Validation and deployment
First run new regressions on unchanged implementation and retain actual failures. Verify both screen content and active mode, plus normal-buffer preservation after a real exit. Browser regression must use the ordinary production snapshot, not injected bytes or forced fallback. Run build, lint:tests, full unit/integration, desktop/emulator E2E and phone fidelity; independent configured-server review, exact final-head PR CI and exact merge push CI must pass before dogfood deployment. On dogfood rerun ordinary alt mode, hidden normal/weak cases, natural streaming/history and real wheel/touch. Save and inspect native screenshots and original failures; missing or failed scenarios never count as passed. Only deploy dogfood. Provide exact candidate and evidence to the master; physical-device/HIL evidence still required before release.

## 6. Scope
One focused PR for mode-preserving snapshots. If weak-background history remains broken after this fix, retain the original failure and describe the next actionable gap instead of widening this PR without evidence. No prod, accepted tag, harness, voice or unrelated static cleanup.

## Observed limits retained for follow-up
Independent review identified saved cursor SGR on live exit. A real tmux diagnostic checks EXIT_RED cell attributes against ANSI capture: both unchanged e07 and this patch fail in cold and warm startup (4 actual failures, color-diagnostic.json). Capture-pane has not supplied saved cursor rendition here. This PR restores mode and normal grid/history/cursor position but does not establish complete attribute fidelity. The release goal is unchanged and this failure remains a required follow-up; it must not be counted as a pass or hidden by pure-text oracles. Two additional unchanged lifecycle static leads (resync cancellation, overlapping old start cleanup) remain unverified and queued.
