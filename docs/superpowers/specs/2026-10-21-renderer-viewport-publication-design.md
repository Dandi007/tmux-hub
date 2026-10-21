# Publish the measured terminal viewport with ordered ownership

## 1. Required behavior
A visible terminal's real renderer measurement must reach tmux. Rapid switching and activation during connection/retry must preserve its latest unsent explicit geometry. Hidden slots must not respond to later window changes. Automatic initialization must respect a newer peer/native owner, and old measurements must not cross connection boundaries.

## 2. Current evidence and cause
Main801821c CI39514914819 failed initial pane equality after rapidb→a, before window resize; trace adopted177×47/197×47. Unchanged local12passes did not establish a runner cause. Controlled real renderer callbacks on801confirmed visible177→197thenhide leaves pane177, and the old100mscompensation overrides newer peer169with197. Separate initial-selector/fixture mistakes remain invalid product evidence.
Independent review then exposed CONNECTING, peer/applied ordering, auth-refresh and retry/native-generation windows. Real TCP-held HTTP101, held actual callbacks/metadata, and a real script/TTY native client reproduced each relevant failure before its fix. Review4causal cases both ended197×47instead of140×36. Earlier full intermediate failures (including203×47client/80×24pane) and all original5/10second assertions are retained. These controlled proofs do not establish identical timing for every historical CI failure.

## 3. Design
Keep displayed authoritative grid, current physical measurement and unsent explicit intent separate:

- Renderer readiness uses public FitAddon.proposeDimensions(), without resizing the displayed peer grid. Save the real measurement even while publication is suspended. Own applied metadata permits publication; peer/native metadata suspends it.
- Automatic publication is resize(ifPinned:true). Inside the server's existing serialized viewport queue it may mutate tmux only if this exact connection is still pinner. Stale work is ignored; the ordered peer publication remains authoritative. Existing input-router native protection applies.
- Explicit fit during connection/retry stores one latest unsent intent, not a history of resize events. It survives backoff and failed attempts until actually sent, cancelled by native authority, or acknowledged as covered by a visible URL pin. Later explicit intent supersedes earlier intent.
- URL measurement remembers the identity of the intent it covers. Open does not duplicate that covered intent; own applied consumes it. A failed initial web pin's plain viewport permits the still-unsatisfied explicit send. Renderer refinement mutates dimensions without creating a new explicit intent; a later user action creates a distinct object.
- Disconnect/new attempt discards automatic measurement and URL-covered markers, so native-era geometry cannot overwrite a fresh URL grid. The latest unsent explicit intent survives.
- Automatic pool attach completion uses fit(false); actual tab activation still reclaims. Remove the100msinitial compensation and blind reconnect-open resize.

Flow: real visible measurement → pending measurement → ordered own ack → conditional resize → serialized pinner check → authoritative grid. Explicit unsent intent → URL coverage or one actual send → consumed. No new timer or scroll-restoration policy change.

## 4. Changed files
- src/web/terminal.ts and desktop/terminal-pool.ts: measurement, publication and intent/connection lifetime.
- src/shared/protocol.ts; server/ws-handlers.ts and session-peers.ts: optional conditional resize and queue-time pinner check.
- desktop-renderer-fit.ts, renderer-proxy.ts, desktop suite registration:12actual timing regressions, public read-only measurement probe, real TCP/TTY controls; tests/integration/ws-viewport.test.ts:3real-WS conditions.
- This spec and AGENTS map.

## 5. Verification and deployment
Retain all causal red/green results, then run build/lint,696unit+integration,80required desktop/emulator E2E and52timing repetitions. Review frozen source increments and exact final tree. Exact PR head and squash main push CI must genuinely succeed before dogfood. Verify runtime SHA and execute9native groups, including2controlled renderer cases and the8previously prepared mode/input/visibility/natural/weak/touch/wheel groups; inspect actual viewport screenshots. Unrun/failed groups remain explicitly unaccepted. Phone Chromium simulation cannot establish physical-device/WebKit/owner HIL. Production and accepted remain outside this loop's authority.

## 6. Scope limits
Unrelated old startup pipe cleanup, saved-SGR/fallback diagnostics and initial/async close leads remain release gaps. Native browser-window resize before reconnect can expose the pre-existing local-fit/native-grid alignment behavior; record actual geometry separately rather than claiming this automatic-publication fix solves all native UI behavior. Do not modify voice, harness or infra. One PR at most this round.
