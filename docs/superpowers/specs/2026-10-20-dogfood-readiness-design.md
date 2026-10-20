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

## 5 测试计划与部署验收

Write tests first and capture failures on the old code. No real deployment,
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

## 6 非目标与限制

No product UI/protocol change, voice work, prod operation, prod deployment behavior
change or harness edit. Readiness retains existing HTTP-success semantics; commit
validation remains the separate existing step. No new JSON health semantics or
rollback behavior.
