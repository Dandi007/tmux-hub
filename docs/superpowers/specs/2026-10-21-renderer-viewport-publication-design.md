# Publish the measured terminal viewport when its renderer becomes ready

## 1. Required behavior
A visible terminal's actual cell grid must reach its tmux pane when the renderer remeasures it. Rapidly switching away must preserve that already-observed grid. Hidden slots must not react to later window changes; a newer peer/native owner must retain its authoritative viewport until an explicit local action reclaims it.

## 2. Current evidence and hypotheses
Main801821c CI39514914819 failed initial size equality after rapidb→a, before window resize. Trace has177×47/197×47adoptions; the unchanged local case passed12times, which does not establish a runner cause. CanvasAddon is initialized after50ms and fit() can change the actual grid. That fit is not published; an independent100msopen callback publishes only if still visible. A switch between these events can leave tmux on the old grid. The exact CI interleaving still needs measured reconstruction; other initial/pending-attach races must not be assumed solved.

## 3. Proposed bounded design
First gate only the existing real renderer/open compensation callbacks in browser regressions. Record actual grids, pane sizes, viewport messages and tab visibility without fabricating dimensions or snapshot bytes. Prove visible remeasurement followed by hiding leaves the pane stale, and verify newer peer ownership survives late renderer initialization.

Measured regressions on801821c confirmed both defects: visible DOM→canvas177×47→197×47 followed by hiding leaves pane177×47; late initialization/100ms compensation overrides a newer peer169×42with197×47. The timer-selector attempts did not reach the behavior assertion and remain fixture failures. Independent review of the first candidate found CONNECTING and peer/applied ordering windows. Real TCP-handshake gating reproduced197×47measurement with pane177×47after hiding; actual held peer/applied callbacks reproduced a skipped renderer fit after local ownership was restored. Real WS regressions demonstrate stale automatic197requests overriding169, including when queued behind the peer mutation.

Renderer readiness fits only a visible eligible web slot and retains the actual measured grid until this socket receives its own applied acknowledgement. A subsequent explicit visible fit refreshes that pending grid. Ordered peer/native metadata suspends automatic work; own applied metadata restores permission. Retain the latest measured grid while ownership confirmation is pending, refreshing it on explicit fit rather than destroying it on an older peer notice. Keep one unsent explicit fit during CONNECTING; renderer remeasurement updates that same latest geometry. Flush it once at open, including a subsequent tab switch; disconnect clears it so old resize intent is never replayed into a later connection. No blind initial/reconnect-open publication or100mscompensation remains. Reconnect already measures and pins via its URL, so open only flushes actual unsent explicit intent. An optional`ifPinned: true`resize distinguishes automatic completion from explicit user intent. Inside the server's serialized viewport queue, automatic correction may mutate tmux only while this exact connection is still the pinner; otherwise it is discarded and the already ordered peer publication remains authoritative. Native protection in the input router still applies. Explicit resize/tab activation keeps its existing reclaim semantics.

Flow: visible renderer measurement → pending latest size → own applied ack → conditional resize → queue-time pinner check → applied grid / peer adoption. No new timer or scroll-restoration change. Pool attach completion uses fit(false) to distinguish automatic catch-up from explicit tab activation. This prevents notification-in-flight takeover without relying on browser notification delivery timing.

## 4. Changed areas
- src/web/terminal.ts: retained real renderer measurement, ordered ownership acknowledgement and conditional publication.
- src/shared/protocol.ts, src/server/ws-handlers.ts, src/server/session-peers.ts: optional automatic-resize condition checked at mutation time.
- tests/integration/ws-viewport.test.ts: real WS conditional ownership and queue ordering.
- tests/e2e/desktop-renderer-fit.ts plus desktop suite registration: eight actual remeasurement/switch, peer takeover, pinned/hidden CONNECTING, before/after ordered peer/applied and initial/reconnect handshake controls; renderer-proxy.ts gates real TCP bytes.
- This spec and AGENTS map. Existing size assertions/timeouts and CI scope remain intact.

## 5. Verification and deployment
Retain failing base behavior, then run measured regressions, original main-failed case, build/lint/full unit+integration and required desktop/emulator E2E. Review frozen patch/source with configured independent model. Exact PR head and squash main CI must truly succeed before dogfood deployment. Verify runtime SHA, run the8prepared native groups with new paths/SHA gates, inspect actual viewport screenshots and retain all failures/unrun cases. Chromium phone simulation cannot establish physical-device/owner HIL. No production or accepted changes.

## 6. Scope limits
Do not modify unrelated startup pipe lifecycle, savedSGR/fallback VT diagnostics, voice, harness or infra. Keep previous failure evidence and the unchanged overall release goal. This round has one PR at most.

Additional acceptance: both initially pinned and pin=0 CONNECTING activation; renderer readiness before/after delayed peer+own confirmations; reconnect initial pin followed by peer takeover while its HTTP101 is held. Existing full-suite initial-size failures remain failures, not runner issues.

Pool attach completion uses fit(false): finishing an older async attach is automatic work, distinct from a later explicit tab activation. Both initial and reconnect HTTP101-held peer takeover must preserve the newer pin.

Final ordering refinement: use FitAddon.proposeDimensions() to measure the renderer without resizing the displayed authoritative peer grid. Measurement remains eligible while publication is suspended; own applied permits a conditional send. This removes the separate rendererMayPin gate that could skip measurement between an older peer notice and newer own acknowledgement. A read-only debug measuredSize exposes the real public-addon measurement for the behavioral oracle. URL measurement captures the identity of the currently pending explicit intent; if the same intent is covered by a visible URL pin it is consumed, while a later explicit action remains pending. Renderer measurement refreshes that object's dimensions without turning automatic work into a new user action. Add peer→renderer→own-applied and refresh-wait→explicit-resize→URL-pin→peer→open regressions before implementation.
