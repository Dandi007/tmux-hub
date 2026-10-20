# Publish the measured terminal viewport when its renderer becomes ready

## 1. Required behavior
A visible terminal's actual cell grid must reach its tmux pane when the renderer remeasures it. Rapidly switching away must preserve that already-observed grid. Hidden slots must not react to later window changes; a newer peer/native owner must retain its authoritative viewport until an explicit local action reclaims it.

## 2. Current evidence and hypotheses
Main801821c CI39514914819 failed initial size equality after rapidb→a, before window resize. Trace has177×47/197×47adoptions; the unchanged local case passed12times, which does not establish a runner cause. CanvasAddon is initialized after50ms and fit() can change the actual grid. That fit is not published; an independent100msopen callback publishes only if still visible. A switch between these events can leave tmux on the old grid. The exact CI interleaving still needs measured reconstruction; other initial/pending-attach races must not be assumed solved.

## 3. Proposed bounded design
First gate only the existing real renderer/open compensation callbacks in browser regressions. Record actual grids, pane sizes, viewport messages and tab visibility without fabricating dimensions or snapshot bytes. Prove visible remeasurement followed by hiding leaves the pane stale, and verify newer peer ownership survives late renderer initialization.

Measured regressions on801821c confirmed both defects: visible DOM→canvas177×47→197×47 followed by hiding leaves pane177×47; late initialization/100ms compensation overrides a newer peer169×42with197×47. The first timer-selector attempts did not reach the behavior assertion and remain separate fixture failures. Replace delayed publication with publication at renderer readiness and initial socket open. Both use the current fitted geometry; automatic work respects visibility, native ownership and a newer peer takeover. Explicit window resize/tab activation can reclaim ownership. Guard the interval before the initial WebSocket is constructed. Avoid introducing another timer or changing protocol/scroll restoration.

## 4. Changed areas
- src/web/terminal.ts: event-driven renderer/open publication and ownership guard.
- tests/e2e/desktop-renderer-fit.ts plus desktop suite registration: real remeasurement/switch and peer takeover controls.
- This spec and AGENTS map. Existing size assertions/timeouts and CI scope remain intact.

## 5. Verification and deployment
Retain failing base behavior, then run measured regressions, original main-failed case, build/lint/full unit+integration and required desktop/emulator E2E. Review frozen patch/source with configured independent model. Exact PR head and squash main CI must truly succeed before dogfood deployment. Verify runtime SHA, run the8prepared native groups with new paths/SHA gates, inspect actual viewport screenshots and retain all failures/unrun cases. Chromium phone simulation cannot establish physical-device/owner HIL. No production or accepted changes.

## 6. Scope limits
Do not modify unrelated startup pipe lifecycle, savedSGR/fallback VT diagnostics, voice, harness or infra. Keep previous failure evidence and the unchanged overall release goal. This round has one PR at most.

Implementation: renderer readiness publishes a fitted grid only for a visible web-owned slot whose automatic pin has not been superseded by peer/native metadata. Explicit local fit/resize can reclaim. Initial socket open publishes immediately, with a construction guard for renderer callbacks during URL resolution; the obsolete100msinitial timer is removed. No extra await or protocol/scroll change. Original failed CI test and its5second assertions remain unchanged.
