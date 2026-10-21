# Native viewport fidelity during browser layout changes

## 1. 第一性原理：要什么
A browser viewing a session attached in a native terminal must keep the native pane's actual grid and screen. Window resize, focus, pointer interaction and desktop tab activation must not locally reflow that screen. After the native client leaves, the browser must reclaim its current container size and continue showing the same actual pane output. This applies to desktop and mobile views.

## 2. 现状与根因
The resize sender checks viewport ownership, but window/focus/pointer and explicit pool fits resize xterm before checking it. This leaves the local grid different from the native pane without any server resize/resnapshot. Round 5 observed browser140x36/pane80x23 with a real attached TTY. Renderer publication already measures without changing native grids. Initial connection measurement is different: the server chooses actual ownership and acknowledges it.

## 3. 方案设计
Gate local layout-driven fits on the same web-ownership condition as resize publication. Keep pending scroll decisions consumable. Do not change initial/reconnect URL measurement, native viewport adoption or native-detach ownership transition. Detach changes ownership to web before fitting and publishing the current layout.

native viewport → adopt native grid → layout/focus/tab: retain grid → native detached → web ownership → fit current container → resize acknowledgement + aligned replay.

No protocol or server changes.

## 4. 改动清单
- src/web/terminal.ts: protect online layout fits from overriding native geometry; add opt-in debug parse barrier for genuine replay readiness.
- tests/e2e/native-viewport-fit.ts and emulator-fidelity.e2e.ts: real native TTY, desktop/mobile online geometry and screen oracle, interaction/resize/reconnect and detach/reclaim.
- tests/e2e/fidelity-foreground.ts: confirm the foreground fit replay is received and parsed before pending-wheel input; retain original navigation assertions.
- AGENTS.md: register this spec.

## 5. 测试计划
First run new assertions against unchanged code and retain actual failure evidence. Seed a real shell pane with output including a right-edge marker; compare xterm rows and grid with real tmux capture-pane during native ownership and after web reclaim. Exercise desktop tab navigation, mobile selection, pointer/focus and viewport resizing. Native tests use the existing owned full-Chrome foreground helper with focus emulation disabled, explicit hidden→visible assertions and raw CDP screenshots; ordinary headless-shell pages stay visible in both tabs (actual probe), so earlier local context passes do not prove foreground transitions. Assert the physical proposed web size changes, native grid remains unchanged, and the post-detach pane reaches the new measured web size (not two matching stale grids). Use isolated sockets and emulator production snapshot path. Run build, test lint, all unit/integration, required desktop/emulator E2E, focused repeats, independent frozen review, exact PR/main CI. Deploy dogfood only after both exact CI runs succeed; repeat actual native ownership and existing stream/history/hidden/weak acceptance on that exact SHA, inspect screenshots and clean owned resources.

### CI readiness correction
The first exact-head PR CI failed the existing pending-wheel case (48 passed/1 failed/72 unrun). Instrumented real traffic proves its screen-equality readiness can return before the foreground fit's resync arrives: a trusted wheel occurred at4315ms, then that resync at4367ms. Thus equality with an older screen cannot establish that the intended replay's bytes are parsed. Retain the CI failure and all positive-navigation/preservation assertions. Track the actual applied viewport for the measured foreground grid, then its real held replay completion, and await a debug-only empty xterm write barrier. Require replayPending still true before real wheel input. No timeout extension, synthetic completion or skipping. This repairs an observed test precondition; it does not prove every timing detail of the original uninstrumented CI failure.

## 6. 非目标与部署条件
No production, accepted tag, harness, infra or voice changes. Physical phone/WebKit/independent HIL remains a separate unmet requirement. One minimal PR; deployment requires genuine green tests and review, and main push CI. Evidence records failed and unrun cases accurately.
