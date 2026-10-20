# Dogfood deployment waits for readiness

## 1 第一性原理：要什么

A successful dogfood restart must not be reported as a failed deployment merely
because its HTTP listener starts slightly after the service manager returns.
Wait a bounded time for readiness. A service that never becomes reachable or
returns a permanent HTTP error must still fail before commit verification and
bookkeeping. A running commit mismatch must remain a failure.

## 2 现状与根因

Round 20 observed deploy-dogfood exit after checkout/build/restart because its
single curl raced Bun binding port 3102. The service was healthy moments later,
but the script never reached _verify_commit or _log_deploy. An invocation-only
curl connection retry wrapper let the unchanged script complete. The shared
_health_check also serves prod; this change stays on the dogfood path.

The round 21 implementation (closed PR #153) was not merged: its CI exposed
the multi-device viewport race and then failed runner checkout. Round 23 fixed
the viewport race in #154, and both CI gates passed. The readiness race was
observed again in that deployment. Round 24 retried the deployment-tool change but closed #155 after two checkout
network failures. Round 26 fixed the initial terminal queue in #156, with green
PR and main push CI (the latter required a network-failure rerun); its deployment
again hit connection refusal before the listener started. Round 27 resumes from
current main b4c40ab, re-running the failing regressions before restoring the
helper. Neither closed PR's checks are counted as current validation.

## 3 方案设计

```
restart dogfood -> bounded curl readiness -> existing commit check -> deploy log
                              |
                         failure -> nonzero exit
```

Add a dogfood-only helper sourced only inside deploy-dogfood. Curl keeps -f and
retries connection refusal/timeouts and its standard retryable HTTP statuses.
Limit to five retries, a ten-second retry-start window, and two seconds per
attempt (including a two-second connect limit). Each retry waits one second.
Six attempts and per-attempt limits make this bounded. Preserve the final curl
exit code in diagnostics and the helper return. A permanent HTTP error such as
403 fails immediately. Do not modify prod functions/branches, commit verification,
accepted handling, or deployment log format.

## 4 改动清单

- deploy/dogfood-health.zsh: sourceable bounded readiness helper, dogfood only.
- deploy/instances.zsh: source and call helper in the dogfood branch.
- tests/integration/dogfood-health.test.ts: real local HTTP endpoints and zsh;
  delayed binding, immediate readiness, transient 503, permanent refusal and
  permanent HTTP error; failure never reaches the caller's success marker.
- This design document under the existing specs directory map.
- AGENTS.md: add this design to the document map.

## 5 测试计划与部署验收

Write tests first and capture the missing-helper failure before adding the
implementation. Separately exercise the original single-curl behavior against
a delayed listener to demonstrate the observed deployment race, without running
any service manager or deployment command in that regression. No real deployment,
service-manager command, default tmux socket or host env file is used by the new
regressions. Run the required isolated build, lint, all unit/integration and
desktop/emulator E2E checks. Review and require PR CI success before squash merge,
then merged-main push CI success before deployment. Since the deployment tool
itself changes, first check out that validated main commit in dogfood-live so
the invoked shell reads the new script, then run its normal deployment command.
On dogfood invoke the updated
script directly, without round 20's curl wrapper; require exit zero, matching
running commit and a deployment record. Open the page with Playwright, check an
exclusive test session's screen against capture-pane and inspect a screenshot.
Keep a dedicated browser session open across the deployment, require automatic
reconnect and new output at the same pane after restart, and verify a new
dogfood deployment-log entry. Only after the merged-main CI succeeds may the
dogfood-live worktree first check out the new deployment script. No temporary
curl wrapper is allowed for this acceptance.

## 6 非目标与限制

No product UI/protocol change, voice work, prod operation, prod deployment behavior
change or harness edit. Readiness retains existing HTTP-success semantics; commit
validation remains the separate existing step. No new JSON health semantics or
rollback behavior.
