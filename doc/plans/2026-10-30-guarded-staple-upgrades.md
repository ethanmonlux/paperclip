# Guarded Staple upstream upgrades
Owner: FAC-760. Preparation only; this branch installs no timer and activates no upgrade.

## Existing mechanism and missing work
Reuse the native managed Git-payload installer, update command, backup, install-store lock and service manager. Exact-SHA installations deliberately stay pinned. The current updater can back up, switch payloads, restart and roll back packages, but does not reconcile fork patches or establish task/effect quiescence. It must not be scheduled directly with --yes.

## Delivery sequence
1. Inventory our live fork patches with regression/evidence paths in maintenance/patch-registry.json. Commit references are provenance, not automatically replayable patches.
2. Pin one upstream master SHA and build a separate candidate. Run each original regression against that upstream without its patch. Compile/import failure, missing fixtures, skipped checks or changed assertions mean unknown, never fixed.
3. Independently review each keep/adapt/retire decision. A clean apply or a conflict alone establishes nothing. Retain patch history and upstream proof when retiring.
4. Build the combined candidate; require exact-head CI, independent review, package provenance, isolated install/boot/assets and real implementation-review-continuation/recovery qualification. Include duplicates, interruption, unknown effects and recovery after restart.
5. Exercise migrations on an isolated private database copy with credentials/logs protected. Inventory retained files and pending recovery obligations. An automatic package rollback is permitted only with verified schema compatibility; otherwise stop for the documented owner-controlled recovery path, never rewind live task/effect history.
6. Extend the existing native updater with an authenticated admission barrier that prevents new dispatch while checking all in-flight runs, preparation, leases, effects and recovery obligations. A read reporting zero processes is insufficient. Stage first; under the owned maintenance barrier recheck candidate identity and evidence, back up, activate using the managed installer/service and verify exact-head health, dashboard and assets. Always release the owned barrier on recoverable failure.
7. Prove one controlled upgrade and recovery. Only then enable a recurring invocation of that reviewed command with the existing desktop service manager, not a new scheduler or Relay integration. Bounded runs, one candidate/PR, no overlap, retained receipts and exception-only founder reporting.

## Initial operating choice
Check upstream daily. Coalesce new commits into one candidate instead of updating per upstream commit. Automate qualified routine updates under standing authority; stop on failed/unknown qualification, unresolved effects, new permissions, spending or incompatible migrations. No timer is installed by this proposal. This schedule is an implementation choice to qualify, not a claim of a scheduled job.

## Ownership and acceptance
This work stays under FAC-760. The other chat owns the existing Facette task and product review; do not wake/reassign it or restart its live worker. PR10 remains the current repair candidate. This preparation branch is not a second repair PR.
PASS requires actual upstream-only patch tests, independent patch decisions, exact candidate CI, migration compatibility evidence, owned quiescent cutover, live verification and a verified recurring native invocation. A registry or Linear link alone enforces none of these.

## Implementation status (STA-21)
Tooling lives in `maintenance/upgrade/` and runs with plain Node, no install: `node maintenance/upgrade/cli.mjs validate | upstream-only --out DIR | admission --evidence FILE`. Tests: `node --test maintenance/upgrade/__tests__/*.test.mjs`.
- Steps 1-2: each registry patch declares an `upstreamOnly` spec. The harness checks out the exact upstream SHA in a temporary worktree, overlays only the fork's test files, proves nothing else differs, runs Vitest with a minimal environment and classifies strictly. Receipts never set a decision. Three patches are `manual-review` (test-harness isolation, fixture portability, CI pin).
- Steps 3-5: `admission` fails closed unless every patch has an independently reviewed decision (retire needs a cited upstream-only pass), exact-head CI is complete and green, an isolated migration applied and the previous payload is schema-compatible, and isolated install/boot/assets/continuation/restart recovery are proved.
- Step 6: the barrier client holds the existing authenticated, owner-scoped `/api/instance/task-drain` (idle purpose answers 503 to all non-control ingress and suppresses scheduling), requires consecutive quiet reads with a positive persisted-work inventory, runs activation, and always releases its own drain. Health must be the authenticated view (serverVersion, serverInfo, startupRecovery ready) at the exact commit. `paperclipai update` now verifies git payload restarts by exact commit, since anonymous health on authenticated deployments carries `commit` but no version.

A failed evidence test counts as `upstream-fails` only when every failure is an assertion; missing exports, type errors and timeouts are `unknown`. Install steps get the egress proxy and private caches; tests get neither. The barrier client uses a direct agent so environment proxies never carry the instance credential.

Upstream-only run against `8595efc2` (harness at `04d73211`, `--install` mirroring upstream `test:run:general` preparation). Fork baselines in the same environment pass every evidence file (HEAD for nine patches, `975bc8d7` for the Codex shell-proxy test):

| Patch | Upstream-only outcome | Evidence |
| --- | --- | --- |
| provider-output-and-mounts | unknown | upstream has no `createNetworkProxyBridge`; the fork test cannot run as written |
| proxy-socket-error-owner | unknown | upstream has no `startNetworkAllowlistProxy` |
| codex-auth-provenance | upstream-fails | 4 assertions: historical auth text still yields `refresh_token_invalidated` |
| claude-auth-provenance | upstream-fails | 11 of 15 assertions: quoted login prose still yields `requiresLogin: true` |
| git-install-payload | unknown | ENOENT during server package preparation; one wrapped assertion |
| installer-test-isolation | unknown | manual review by design |
| portable-runner-fixtures | unknown | manual review by design |
| portable-sandbox-denial | upstream-passes | required test passes; one unrelated containment test skips in this sandbox, as on the fork |
| trusted-ci-baseline | unknown | manual review by design |
| codex-shell-proxy-allowlist | upstream-fails | identity-filtered Codex shell env lacks the allowlist bridge |

These are receipts, not decisions. `upstream-passes` supports retirement only with an independent review.

Remaining gates, none satisfied yet:
- Independent keep/adapt/retire review per patch. `unknown` patches need an adapted upstream test or direct review before any decision.
- Build the combined candidate from those decisions and run exact-head CI. No combined candidate exists yet.
- Isolated migration on a private database copy (89 SQL migration paths) and rollback compatibility evidence.
- Server: the only persisted-work inventory today is `idleSleepSafety`, which treats any open issue, routine or API key as work, so a real instance will not pass it. A narrower upgrade inventory (in-flight runs, wakes, leases, effects, recovery obligations) is needed. Task drain is in memory, so it does not hold across the restart into the new payload.
- Wire the barrier and admission into the native update path, prove one controlled upgrade and recovery, and only then add a recurring native invocation. `automaticActivationEnabled` stays false.
