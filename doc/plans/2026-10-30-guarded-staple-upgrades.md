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
Tooling lives in `maintenance/upgrade/` and runs with plain Node, no install: `node maintenance/upgrade/cli.mjs validate | upstream-only --out DIR | admission --evidence FILE | migration-inventory --base SHA --candidate SHA`. Tests: `node --test maintenance/upgrade/__tests__/*.test.mjs`.
- Steps 1-2: each registry patch declares an `upstreamOnly` spec. The harness checks out the exact upstream SHA in a temporary worktree, overlays only the fork's test files, proves nothing else differs, runs Vitest with a minimal environment and classifies strictly. Every attempt runs in its own fresh directory (worktree and report), so a runner that writes no report is `unknown` and can never inherit an earlier attempt's pass. Receipts (schema v2) record the attempt ID, upstream tree, the fork test blobs and the report hash; reviews cite a receipt by its canonical digest. Receipts never set a decision. Three patches are `manual-review` (test-harness isolation, fixture portability, CI pin).
- Steps 3-5: `admission` fails closed unless:
  - the evidence names the candidate head, its upstream, the authority and a non-empty implementer list;
  - every patch decision has a clean, independent review of that exact head, upstream and authority, citing the upstream-only receipt for the registry's fork source (retire needs that receipt to be an upstream-only pass);
  - a separate clean, independent review covers the combined candidate head and the exact registry state (by digest);
  - every check run on the exact head, across all workflows and fully paged, completed with success, including the registry's reviewed `requiredCiJobs`. There are no exemptions; pending checks are unknown;
  - an isolated migration applied and the previous payload is schema-compatible, and isolated install/boot/assets/continuation/restart recovery are proved.

  A review of any other head is stale, so every candidate change needs fresh review. Any non-clean or verdict-less current review blocks.
- Step 6: the barrier client holds the existing authenticated, owner-scoped `/api/instance/task-drain` (idle purpose answers 503 to all non-control ingress and suppresses scheduling), requires consecutive quiet reads with a positive persisted-work inventory, runs activation, and always releases its own drain. Health must be the authenticated view (serverVersion, serverInfo, startupRecovery ready) at the exact commit. `paperclipai update` now verifies git payload restarts by exact commit, since anonymous health on authenticated deployments carries `commit` but no version.

A failed evidence test counts as `upstream-fails` only when every failure is an assertion; missing exports, type errors and timeouts are `unknown`. Install steps get the egress proxy and private caches; tests get neither. The barrier client uses a direct agent so environment proxies never carry the instance credential.

Stage 3 (harness `ef0d58e0`, fork source `5305f21c`):

- **Evidence source.** Registry evidence now comes from live PR #10 head `5305f21c`. Two later repair groups, `github-launcher-run-scope` and `claude-terminal-cleanup`, are registered, for 12 patch groups in total.
- **New harness capabilities.**
  - Export-only shims reach upstream's module-private code.
  - Reviewed ports under `maintenance/upgrade/ports/` run from their committed blob.
  - Tests run in a private user+network namespace.
  - A `resolves` rejection whose reason is an AssertionError counts as an assertion.
- **Results.**
  - `provider-output-and-mounts`, `proxy-socket-error-owner` and `git-install-payload` move from unknown to **upstream-fails**.
  - Every automatable fork control passes.
  - Receipts, proposed decisions and the static migration inventory are in `doc/plans/2026-10-31-guarded-upgrade-patch-decision-proposals.md`. Raw receipts and reports are attached to STA-21 as an evidence bundle with a SHA-256 manifest.
  - Earlier receipts (harnesses `04d73211` and `3dceff56`) are superseded, not deleted.
- **`migration-inventory`.** This command statically classifies a candidate's new migrations against the installed schema. On upstream it finds nothing destructive, but 76 statements that are a risk to the previous payload and 6 data rewrites on existing tables. Automatic rollback is not assumed safe.
- **CI.**
  - A `maintenance upgrade toolkit` job runs the toolkit suite with its isolation test required.
  - `requiredCiJobs` is declared for the current CI shape. Every check on the head must still succeed.
  - The inherited `review` check (commitperclip, missing `COMMITPERCLIP_KEY` on the fork) fails on every head. It runs from the fork's `master` under `pull_request_target`, so this branch cannot change it. It blocks admission until an owner provisions the key or removes that workflow from the fork through its own reviewed change.

Remaining gates, none satisfied yet:
- Independent review of the twelve proposed decisions, and of the two `unknown` receipts that rest on source evidence.
- Owner action on the failing `review` check. After that, exact-head CI on the published head.
- Build the combined candidate from accepted decisions: upstream `8595efc2` plus kept and adapted patches, with `pr.yml` re-pinned. Then its exact-head CI, package provenance and isolated install/boot/assets. No combined candidate exists yet.
- Isolated migration of a private database copy, run with the previous payload against the migrated schema. Until then, an incompatible schema means the owner-controlled recovery stop.
- Server: a narrower persisted upgrade inventory (in-flight runs, wakes, leases, effects, recovery obligations) and a drain fence persisted across restart, with exact-owner reconciliation of an unknown acquisition or activation. Task drain is in memory today.
- Wire the barrier and admission into the native update path, prove one controlled upgrade and recovery, and only then add a recurring native invocation. `automaticActivationEnabled` stays false.
