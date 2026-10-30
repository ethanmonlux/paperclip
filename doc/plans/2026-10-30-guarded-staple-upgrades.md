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
