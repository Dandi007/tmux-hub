# Preserve alternate screens across replay and resize exit

## 1. User behavior and constraints
A reconnecting full-screen application must remain in its alternate screen: wheel navigation must not expose normal history. Exiting must restore the normal screen, history and cursor, including after resize. Desktop and phone must preserve their actual input behavior. Keep normal-history intent and streaming following intact. Use ordinary authoritative capture, not forced fallback or injected replacement snapshots. This is one bounded improvement toward the unchanged release goal; failed or missing acceptance remains outstanding.

## 2. Observed problems
Deployed e07e0c8 fails desktop/phone: tmux alternate_on=1, but ordinary replay lets wheel change distance from bottom0→25 into old history. Capture combines RIS, text and ModeShadow without entering alternate. Emulator fallback preserves mode, but cannot replace the ordinary path or infer every cold-start mode.

Real resize/exit regression additionally shows a two-row normal-screen shift: tmux defers expanding its saved normal grid until alternate exits. A capture taken while alternate remains active still contains the old normal grid. A quiet-only repair never runs during continuous50ms output. Five forced overlaps can also duplicate a pre-applied relative LF, so necessary repair must survive the first capture.

RIS drops input/output modes. Actual tests found application cursor/paste loss, missing origin/no-wrap state, stale mouse encoding after RIS and missing legacy mouse bytes. xterm emits legacy packets through onBinary; the client only subscribed to onData. Partial geometry/history failures must not be certified as complete ordinary snapshots.

The prior weak-background history60 failure is intermittent and its relationship to these defects is unproven. A fresh unchanged-base group10/10 passing does not erase the original failure.

## 3. Design
- Read all7geometry fields together: cursor, history, height, alternate and saved cursor. Normal queries emit explicit0saved-cursor values; missing/error fields use logged emulator fallback.
- Paint normal history (capture without -a), saved normal visible grid (-a), saved cursor, canonical1049h, then active alternate grid. Restore persistent modes and current cursor. Required capture errors, including history-only failure, produce non-authoritative fallback.
- Deliver internal SnapshotInfo only for the final aligned snapshot: alternate, pending normal exit since capture began, overlapped, authoritative. Parse actual live DECRST47/1047/1049 and RIS after emulator priming. Pending exits during the final tolerated overlap still reach the consumer.
- Each resync-capable WS remembers its own alternate snapshot. Ordinary live enter/exit without replay adds no refresh. A necessary exit repair uses the existing ordered scheduler, survives overlapped/degraded captures and retries independently of quiet with100/200/400/800/1000msbackoff. A complete non-overlapped authoritative capture clears it. Generic busy-overlap recovery retains its existing quiet policy.
- Restore persistent public modes supported by the browser, following SerializeAddon policy: input modes, insert, origin, reverse-wrap, focus and wrap. Temporary synchronized output is not serialized. Position the authoritative cursor relative to the tracked origin margin. ModeShadow clears stale state on RIS. Both renderers ignore DECSTR to match the measured tmux3.6behavior rather than applying xterm's different soft reset. It handles default/invalid margins and resets margins on row changes while preserving them on width-only changes. These resize semantics were verified on real tmux3.6.
- Add a compatible binary input message for xterm onBinary. Validate the complete Latin1 string before any partial send, keep session input ordering and inject bounded chunks with tmux send-keys -H. onData continues the text path; binary events do not predict text echo. Readonly phone terminals retain their toolbar/composer path. Server and current assets deploy together.
- Initialize capture dimensions once per attach; alignment retries reuse the current shared emulator so they cannot roll back a later applied resize and erase freshly observed margins. Avoid unnecessary fallback cursor positioning that cancels a pending normal right-edge wrap.
- Test generators retain stop files until an app-written acknowledgement. After500mswithout acknowledgement, terminate only the owned private session, confirm absence, then remove files. Real private tmux tests cover failed checks and stuck generators with an unrelated keeper remaining alive.

## 4. Changed areas
- output-broadcaster: ordinary two-grid snapshot, strict geometry, complete-capture provenance and final metadata.
- session-emulator / mode-shadow: live exit requests, persistent modes, reset semantics and origin-aware cursor.
- ws-handlers / resize-resync: per-connection required repair, bounded retry and existing close compensation.
- shared protocol / input-router / web terminal: byte-preserving legacy input path.
- Snapshot, overlap, geometry, mode, binary input and cleanup unit/integration tests; existing fakes use the actual complete geometry contract with assertions retained.
- fidelity-alternate and suite: actual desktop/phone mode, wheel, resize, continuous output and platform input behavior.
- Owned generator helper, this spec and AGENTS index.

## 5. Validation and deployment
Retain actual failing baselines before implementation. Real tmux cold1049/47/1047 tests validate both buffers, history, cursor and live exit. Full WS renderer regressions force five pre-applied relative LF captures while5msredraws continue, and a history-only failure followed by recovery. These are controlled capture runners, not claims of physical tmux online reproduction.

Desktop/phone browser cases use production ordinary replay, actual wheel, offline entry, fresh attach, resize, exit, normal-history reconnection and continuous output. Platform controls cover ordinary no-replay/no-refresh and replayed exit. After real repair, the app continues output at the right edge with origin/no-wrap set; desktop validates actual clipboard/cursor and legacy high-coordinate mouse bytes after RIS. Mobile xterm is readonly by design: its valid tests use the toolbar, literal+Enter composer and no raw mouse report. Earlier raw-xterm mobile input was an invalid fixture and is not counted as a product failure.

Binary integration checks all256byte values across chunks followed by ordinary text, and rejects non-byte input before sending anything. Run build, test lint, full unit/integration, required desktop/emulator E2E and phone fidelity. Independent frozen-source review and exact final-head PR CI must pass; exact merge push CI must pass before dogfood deployment. Verify runtime SHA, then run real dogfood normal/weak background, streaming/history, resize and actual wheel/touch, compare pane output and viewport, and inspect native screenshots. Never count unrun or failed scenarios as passed.

Only deploy dogfood. Provide exact candidate, CI and actual observation evidence to the master. Chromium phone simulation does not establish physical-device/iOS/owner HIL.

## 6. Retained release gaps
Direct real-tmux broadcaster saved-SGR diagnostics fail on unchanged base and candidate in cold/warm cases: EXIT_RED is default instead of red. They bypass WS repair and do not establish the browser's final color after automatic repair. Cold unobserved input modes are not established by restoring observed modes. These limits are not waived from the overall fidelity goal.

Independent review also found an unchanged old-start/same-name replacement race. A controlled fake runner reproduces old continuation closing the new pipe on base and candidate; it is not a real-tmux online reproduction. Its lifecycle fix remains a separate required follow-up. Prior unrelated static leads and the intermittent background failure remain recorded for actual reproduction/closure. Production, accepted, harness and voice remain untouched; the unrelated lifecycle implementation stays a separate required PR.

DECSTR oracle correction: actual tmux3.6kept cursor/margins/mouse encoding unchanged after CSI!p, while RIS reset all of them. Therefore the initial xterm-soft-reset expectation was an invalid oracle and was corrected with the raw primary probe retained. Server and browser ignore the unsupported command; the platform test explicitly sends it and checks actual pane/input/output behavior.

Final review boundary: the no-margin pending-wrap regression is repaired. A focused base/candidate diagnostic still fails fallback pending-wrap with origin and custom margins in both versions; it remains a release gap, not a passing case. Normal-history E2E waits for announced repair parsing to finish before navigation; replay-time intent remains covered separately. Original wheel-race failures and new diagnostic samples remain archived.

CI fixture correction: an interrupted resync can be announced on the old socket without a replay completion, so replays minus resyncs is not a connection counter. The existing debug-only TerminalProbe now exposes the actual latest parse/restore gate as readonly replayPending. Normal-history navigation waits for this gate without changing restore behavior or behavior assertions. The first CI690unit+43E2Epass/1fixture-fail/61unrun remains retained and is not acceptance evidence.

Debug completion uses ReplayProgress generations: begin when resync/reconnect is announced, capture the generation when scrollpos arrives, and complete only that generation after its parse barrier. Old callbacks cannot mark a newer generation complete; an abandoned old replay does not block the latest completion. This observation is independent of the unchanged product restore/reporting gate. Three unit cases cover sequential, overlapping and abandoned callbacks.
