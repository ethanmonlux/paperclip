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
  - The inherited `review` check (commitperclip, missing `COMMITPERCLIP_KEY` on the fork) fails on every head. Under `pull_request_target` its workflow file runs from the PR's base branch, and its job checks out `master`, so this branch cannot change it. It blocks admission until an owner provisions the key or removes that workflow through its own reviewed change.

Stage 4 (STA-22 finding R4, expected CI coverage):

- **Expected-lane graph.** `ci-graph` regenerates every check a pull request must produce from exact workflow blobs: the head's `pull_request` workflows, the base branch's `pull_request_target` workflows and each reusable workflow pinned by full SHA. It expands matrices and records which lanes each aggregate needs. It reads a small YAML subset; dynamic matrices, `exclude`, anchors, unnamed matrix jobs, mutable `uses:` refs or an unavailable pinned workflow make the graph unsupported, which admission treats as unknown. Trigger syntax is positively validated (R5): only a plain event name, a flow list of names, or a block mapping whose pull-request events carry documented filters and `types` are decoded. Flow-mapping triggers such as `on: {pull_request: {}}`, inline event configuration, unknown event keys, duplicate keys, tab-led lines, a missing or empty `on:` and symlinked workflow files are unsupported, never skipped. The graph also pins every file in `.github/workflows/` at the head and the base context by blob, so any added, changed or removed workflow, including one that never runs for a pull request, makes the regenerated graph differ until it is reviewed again. Path-, branch- or activity-filtered workflows are recorded as conditional: their checks must succeed if present but are not expected.
- **Committed graph.** `maintenance/ci-graph.json` has 50 expected lanes, including all nine `ci / Verify serialized server suites (n/9)` shards and `review`. `ci / verify` needs 28 lanes and none of the serialized shards, so a green aggregate never stands in for them. The registry's `requiredCiJobs` now equals the graph's lanes, and `ciGraphDigest` binds the registry (and therefore the candidate review) to that graph. After R5 the graph also records 40 pinned workflow files (20 head, 20 base) with unchanged lanes, aggregates and calls; `ciGraphDigest` is now `98bf4d66…`.
- **Admission.** `candidate-ci` fails if the required set omits a graph lane or names one the graph does not produce. It is unknown if the graph was not regenerated from the candidate or differs from the reviewed one (changed blob, pin or lane set). The CLI derives the graph from Git and refuses a graph supplied in evidence. The all-observed-success and no-exemption rules are unchanged.
- **CI.** The toolkit job fetches the PR head, base branch and pinned reusable workflow, and fails if the committed graph differs from what they produce.
- **Serialized shard 1/9 on `e5decf9f`.** One test failed: `heartbeat-process-recovery.test.ts` "keeps an explicit local-path/worktree conflict blocked…" (missing `configurationReason`). It ran on runner image `ubuntu-26.04` `20261018.50.1`; the passing run on `acfcfae3` used `20261025.179.1`. `server/` is identical between the two heads. The flag requires `probeGitWorktreeBase` to match Git's exact "not a git repository (or any of the parent directories)" stderr and find no Git metadata in any ancestor. Both conditions depend on the host: Git prints a different message when it stops at a filesystem boundary (for example a separate `/tmp` mount). The test also fails deterministically in the engineer sandbox (`/tmp` is its own tmpfs and `git` is a run-scoped wrapper), but setting `GIT_DISCOVERY_ACROSS_FILESYSTEM=1` there does not make it pass, so neither the local nor the CI cause is isolated. Attribution remains unknown. The code is inherited repair-base code, not changed by this branch; no assertion was weakened and no rerun was made.

Stage 5 (repair base `b2385913`, harness `113b51bf`):

- **Base sync.** PR #11 merged its moved base `b2385913` (merge `9679079f`). The upgrade diff is byte-identical to the one reviewed before the merge, so the CI lane graph and its digest are unchanged.
- **Registry.** Evidence and fork patch source move to `b2385913`. Two new groups bring the total to 14:
  - `native-handoff-admission` (`a0809c5c`, `00d786b6`, `2a34dfba`, `b2385913`) with policy and real-Postgres dispatch regressions;
  - `recovery-fixture-isolation` (`83f770b3`), manual review.
- **Harness.** The opt-in `private-network-user` isolation keeps the private network namespace but runs tests as the caller's own uid/gid. Embedded Postgres refuses to run as namespace root and would otherwise skip, which is unknown.
- **Receipts.** Every group was re-run against upstream `8595efc2` and, as the control, against `b2385913`:
  - The 12 earlier groups reproduce their stage-3 outcomes.
  - `native-handoff-admission` is `unknown` upstream: 7 of 9 required tests fail, 5 with assertions and 2 with timeouts. Its control passes 9/9 (121/121 in the file, nothing skipped).
  - Every automatable control passes.
  - Proposals for all 14 groups are in the proposals document.
- **CI on `9679079f`.** It failed 47/50:
  - `review` failed on the missing key.
  - `ci / e2e shard (1/8)` failed at `chat-adapters-ui-messaging.spec.ts:217`: the `Paperclip announcements` aside, fed from the live remote announcements feed, intercepted a click. Attribution is unproven. No e2e configuration disables that feed, and neither this branch nor the base change touches UI, announcement or e2e files.
  - `ci / e2e` failed as the aggregate of that shard.
  - `ci / verify` does not need the e2e lanes, so it passed. Admission still fails, because every lane must succeed.

Stage 6 (ports `875e99ab`, card `4206f0e6`):

- **Ports.** STA-22 round 6 left `github-launcher-run-scope`, `claude-terminal-cleanup` and `native-handoff-admission` `unknown`: their originals call fork-only helpers or pause inside a mock of one. Observation-only ports in `maintenance/upgrade/ports/<group>/` now observe the same behaviours through boundaries upstream and the fork share (Codex and Claude `execute()`, real Postgres row locks). No production fix is imported, the configured timeouts are unchanged and the registry stays `unassessed`. Each `PORT.md` lists what changed and what is not covered.
- **Receipts** (upstream `8595efc2`, control `b2385913`):
  - `github-launcher-run-scope`: **upstream-fails**, 2 of 6 required by assertion (no canonical own-run mount). The three denial tests pass upstream only because upstream mounts no launcher directory. Control 6/6.
  - `claude-terminal-cleanup`: **upstream-fails**, 19 of 35 by assertion. Control 35/35.
  - `native-handoff-admission`: **upstream-fails**, 7 of 9 required by assertion, no timeouts. Control 9/9, file 121/121.
- Proposals for all three stay **adapt**.

Stage 7 (ports `8e8c2d36`, card `be840d6f`, STA-22 finding R6):

- **Port.** The `native-handoff-admission` cancellation case started the revocation before the gate, so it never showed the invitation lock is held from the gate's read until the provider handoff. A new dispatch-first case pauses the gate's own transaction after that read through a test-only `Db` seam, and requires dispatch while that transaction is still open, before the revocation. The other cases, the production code and the timeouts are unchanged. The registry adds the case to the required tests and stays `unassessed`.
- **Receipts** (upstream `8595efc2`, control `b2385913`, this group only): **upstream-fails**, 8 of 10 required by assertion, no timeouts (`e54579c3`). Control 10/10, file 122/122 (`e4b7fb00`).
- **Negative control.** Under STA-22's early-unlock mutation, applied in memory, the new case fails and the cancellation-first case still passes, as R6 described. The proposal stays **adapt**.

Remaining gates, none satisfied yet:
- Independent review of the fourteen proposed decisions, including the stage-6 ports and receipts for `github-launcher-run-scope` and `claude-terminal-cleanup`, and the stage-7 `native-handoff-admission` port and receipts (R6).
- Owner action on the failing `review` check, and attribution of the e2e shard 1/8 announcements failure. Serialized shard 1/9 has passed since base commit `83f770b3`. After that, exact-head CI on the published head.
- Independent review of the expected-lane graph and its reader (R4).
- Build the combined candidate from accepted decisions: upstream `8595efc2` plus kept and adapted patches, with `pr.yml` re-pinned. Then its exact-head CI, package provenance and isolated install/boot/assets. No combined candidate exists yet.
- Isolated migration of a private database copy, run with the previous payload against the migrated schema. Until then, an incompatible schema means the owner-controlled recovery stop.
- Server: a narrower persisted upgrade inventory (in-flight runs, wakes, leases, effects, recovery obligations) and a drain fence persisted across restart, with exact-owner reconciliation of an unknown acquisition or activation. Task drain is in memory today.
- Wire the barrier and admission into the native update path, prove one controlled upgrade and recovery, and only then add a recurring native invocation. `automaticActivationEnabled` stays false.
