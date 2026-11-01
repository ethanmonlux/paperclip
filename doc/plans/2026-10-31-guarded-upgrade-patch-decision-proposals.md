# Guarded upgrade: proposed patch decisions for independent review

Owner: FAC-760 / STA-21. These are **proposals**. The committed registry keeps
every decision `unassessed` until an independent reviewer accepts or changes
each one against the cited receipts. A proposal is not a decision.

Inputs:

- Upstream candidate `8595efc20bda3ce20a9fbbf34a5d156a6fcf6d57` (tree `772753c6`).
- Fork source: live PR #10 head and PR #11 base `b2385913e0f2048af05a3a60a0e4515528c7cb07`
  (stage 3 used `5305f21c`; the receipts below were re-run against `b2385913`).
- Harness and ports at commit `113b51bf66110d83c22262b66ddc914a0c615a07`. Stage 6 re-ran
  `github-launcher-run-scope`, `claude-terminal-cleanup` and
  `native-handoff-admission` through new observation-only ports at
  `875e99abdbd395117a83973cf3d480cf321e57bc`; their rows cite those receipts.
  Stage 7 re-ran `native-handoff-admission` alone with the R6 dispatch-first
  case added, ports at `8e8c2d36b424072ca464826c6f9ef804412966dd`; its row
  cites those receipts.
  Stage 8 added `native-task-bound-continuation` (fix `53373965`, port
  `cf1c70a6`); its R7 follow-up `6e5f6590` (registry `01050b56`) re-ran that
  group. Stage 9 `37b2bf5b` (registry `ae6f2046`) re-ran it again with the
  addressed-wake drain regressions, stage 10 `010c5180` (registry
  `cb559ead`) with the R8 drain-intent regressions, and stage 11 `71bf3065`
  (registry `b5e84da5`) with the R9 locked-row regressions. Its row cites the
  stage-11 receipts, with control = the fix commit.
  Stage 12 added `controller-lease-loss-attribution` (fix `8cf65148`, registry
  `d19d922a`); its row cites those receipts, with control = the fix commit.
  Stage 13 added `native-self-wake-suppression` (fix `1947665a`) and
  `native-comment-redelivery` (fix `484c0954`), registry `6ea6bf16`; their
  rows cite those receipts, with control = each fix commit. The redelivery
  row now cites the receipts after correction `7ada55ee` (registry
  `7ede11e7`), with control = that commit.
- Each test ran in a private user+network namespace, after an install that
  mirrors upstream `test:run:general` preparation. `native-handoff-admission`
  uses `private-network-user`, which keeps that network namespace but runs as
  the caller's own uid/gid, because embedded Postgres refuses to run as root.
- Control: the same harness, install and ports run against the fork itself.
  Every automatable patch passes there, so an upstream failure comes from
  upstream, not from the test, port, shim or environment.

Meaning of the decisions:

- **keep**: carry the fork change onto upstream unchanged.
- **adapt**: carry the same behavior, but re-apply it to an upstream file
  that has changed.
- **retire**: drop the fork change because upstream covers the behavior.

"Upstream file state" compares each source file of the patch between stable
`1b4c8038` and upstream: identical, changed, or absent.

| Patch | Upstream-only (receipt prefix) | Fork control | Upstream file state | Proposal |
| --- | --- | --- | --- | --- |
| provider-output-and-mounts | **upstream-fails** 4/5 (`19b6ba9a`), export-only shim | passes 5/5 | `local-process-sandbox.ts` identical to stable | **keep** |
| proxy-socket-error-owner | **upstream-fails** 1/2 (`5d7f1931`), export-only shim | passes 2/2 | same file, identical to stable | **keep** |
| codex-auth-provenance | **upstream-fails** 4/6 (`d5b7a7a4`) | passes 6/6 | `parse.ts` identical to stable | **keep** |
| claude-auth-provenance | **upstream-fails** 11/15 (`a99c7d63`) | passes 15/15 | `parse.ts`/`acp.ts` identical; `test.ts` changed | **adapt** (`test.ts` caller) |
| git-install-payload | **upstream-fails** 3/3 (`5d362d2f`), port `58ce7442` | passes 3/3 | `install.ts` changed (npm 12 hunk only) | **adapt** |
| installer-test-isolation | unknown, manual (`1e6847ae`) | n/a | test file changed; the global service-manager isolation is absent upstream | **adapt** |
| portable-runner-fixtures | unknown, manual (`205f10b6`) | n/a | test changed; upstream still copies `/bin/sleep` | **adapt** |
| portable-sandbox-denial | upstream-passes 1/1 (`4be8d10e`) | passes 1/1 | test identical to stable | **keep** (test-only, not retire) |
| trusted-ci-baseline | unknown, manual (`eac37fea`) | n/a | `pr.yml` changed | **adapt** |
| codex-shell-proxy-allowlist | **upstream-fails** 1/1 (`4b1d6975`) | passes 1/1 | `execute.ts` changed | **adapt** |
| github-launcher-run-scope | **upstream-fails** 2/6 (`9fd01346`), port `875e99ab` | passes 6/6 (`5e36f24f`) | `execution-target.ts`/`execute.ts` changed; helper absent | **adapt** |
| claude-terminal-cleanup | **upstream-fails** 19/35 (`85909f69`), ports `875e99ab` | passes 35/35 (`a56ff983`) | `execute.ts`/`server-utils.ts` changed; `parse.ts` identical | **adapt** |
| native-handoff-admission | **upstream-fails** 8/10 (`e54579c3`), port `8e8c2d36` | passes 10/10, file 122/122 (`e4b7fb00`) | `policy.ts` identical; `postgres.ts`, `issue-thread-interactions.ts`, `api-reference.md` changed; `pending-agent-interaction.ts` absent | **adapt** |
| recovery-fixture-isolation | unknown, manual (`fb53e68c`) | n/a | test file changed; upstream fixture still under `os.tmpdir()` | **adapt** (test-only) |
| native-task-bound-continuation | **upstream-fails**, 56 of 88 required by assertion (`698e53cd`), ports `b5e84da5` | passes 88/88, files 112/112 (`06d92ac7`) | `legacy-continuation.ts`, `issue-continuation-summary.ts`, `wake-queue/domain/values.ts` identical to stable; `service.ts`, `postgres.ts`, `issues.ts`, `heartbeat.ts`, `run-preparation.ts`, `wake-queue` use-cases/adapter/policy, `heartbeat/queue.ts`, `run-control.ts` changed; `issue-stage-boundary.ts` new; `pending-agent-interaction.ts` absent | **adapt** |
| controller-lease-loss-attribution | upstream-passes 28/28 (`2acd7e95`), ports `d19d922a` | passes 28/28 (`a130dec3`) | `legacy-controller-lease.ts`, `run-cancellation.ts`, `run-completion.ts` changed: upstream already has the typed lease-loss attribution | **retire** on upgrade |
| native-self-wake-suppression | **upstream-fails** 3 of 7, by assertion, only through the unblock-owner notification (`549d8406`), ports `6ea6bf16` | passes 7/7 (`f3d3dc94`) | `issue-dependency-wakeups.ts` and the backstop guard identical to upstream; `routable-blocked.ts` notifies a self-named writer upstream | **adapt** |
| native-comment-redelivery | **upstream-fails** 5 of 12 by assertion (`21e11948`), ports `7ede11e7` | passes 12/12, file 15/15 (`5d3d9f53`) | wake-queue adapter, use-cases and policy have no delivered-comment check | **adapt** |

Only `controller-lease-loss-attribution` is proposed for retirement, on
upgrade: its fork port reproduces upstream's own attribution and upstream
passes every regression. Upstream-only evidence does not show that upstream
covers any of the other behaviors.

## Notes per patch

- **provider-output-and-mounts / proxy-socket-error-owner.**
  - Upstream `local-process-sandbox.ts` is byte-identical to stable (blob
    `95f6227a`), so the pre-fix code is unchanged upstream.
  - Upstream keeps the bridge and proxy module-private. The run adds only the
    `export` keyword; the harness verifies that is the whole diff and records
    both file hashes.
  - On a plain host, the upstream bridge's fixed port 31337 collided with this
    sandbox's own proxy, which produced fake exit-1 failures. The private
    network namespace removes that collision: the stdin/argv/exit test then
    passes upstream, while the output-preservation, cancellation, drain and
    socket-ownership assertions fail.
  - Merged-usr mounts still have no dedicated regression and need manual
    review.
- **git-install-payload.**
  - The original fixture crashed with ENOENT because upstream never stages
    `server/ui-dist`. The port (`maintenance/upgrade/ports/git-install-payload/PORT.md`)
    makes that absence an assertion and changes no expected value.
  - On upstream, the UI and skills are not staged. The server manifest keeps
    `^0.3.1` instead of the dependency's own version, and the build stamps the
    enclosing repository's commit instead of the requested archive SHA.
- **portable-sandbox-denial.**
  - The patch only changes a test. Upstream code passes the fork's portable
    assertion, but upstream's own test file is unchanged from stable, so
    retiring the patch would restore the non-portable assertion.
  - Keep the fork's test version. Retirement is not proposed.
- **github-launcher-run-scope** (stage 6, port `ports/github-launcher-run-scope/PORT.md`).
  - Stage 5 was `unknown` because the helper tests import the fork-only
    `localGitHubLauncherSandboxPaths`. The port observes the same behaviours
    through the Codex adapter's real `execute()`.
  - Upstream fails 2 of 6 required tests, both by assertion: it does not mount
    this run's canonical launcher directory, and does not pass the managed
    launchers into the sandbox.
  - The three denial tests (arbitrary directory, another run, symlink) pass
    upstream only because upstream mounts no launcher directory at all. They
    do not show that upstream enforces run scope.
  - The Claude adapter's launcher mount still has no evidence file; it stays
    a combined-candidate item.
- **claude-terminal-cleanup** (stage 6, ports `ports/claude-terminal-cleanup/PORT.md`).
  - Stage 5 was `unknown` because the tests call the fork-only latest-turn
    tracker. The ports run the same scripted provider output as real child
    processes through `execute()`.
  - Upstream fails 19 of 35, all by assertion: lingering processes after a
    terminal result are not finalized as success, stale results are not
    cancelled, and the cleanup disposition is not recorded. The 16 upstream
    passes are the unchanged mocked-process tests.
  - One capture-internal assertion was dropped from the port because
    `execute()` does not expose it; see PORT.md.
- **native-handoff-admission.**
  - Upstream fails 5 of the 9 required tests with assertions: the policy
    still reports the addressed participant's wake as stale, the Postgres
    adapter cancels the persisted handoff and denies the pending-invitation
    retry. In stage 5 the other two required failures were 15 s timeouts,
    because they paused inside a mock of the fork-only helper. The stage 6
    port (`ports/native-handoff-admission/PORT.md`) pauses the real gate
    with test-held Postgres row locks instead. Upstream now fails all 7 by
    assertion: no lock wait on the invitation row during cancellation, and
    `update "issues"` instead of an issue-first `select` lock in the
    expiry ordering. The stage 6 receipt was `upstream-fails` (`157ced83`).
  - STA-22 round 7 (R6) found the stage 6 cancellation case too weak: it
    starts the revocation before the gate, so an early-unlock mutation
    passed it while the `b2385913` original failed. Stage 7 adds a
    dispatch-first case through a test-only `Db` seam (see PORT.md). It
    pauses after the gate's locked invitation read, requires the
    cancellation to wait on that reading backend, and requires dispatch
    while that transaction is still open, before the revocation. Upstream
    fails it by assertion at `reached`: its gate never makes a locked read
    of the invitation. The fresh receipt is `upstream-fails` (`e54579c3`),
    8 of 10 required failing, all by assertion, no timeouts. The control
    passes 10/10 and 122/122 in the file (`e4b7fb00`).
  - Under the reviewer's early-unlock mutation, applied in memory to the
    control, the new case fails by assertion, the `b2385913` original also
    fails, and the cancellation-first case still passes. Unmodified, the
    new case and the original both pass.
  - The port's own mutation check (each fix reverted in a scratch tree of
    `b2385913`, only the matching test fails) ran in stage 6's first
    sandbox, whose receipts were lost. It has not been re-run.
  - Three tests outside the required set fail only upstream, on a
    `budget_reservations ... for update` query. They pass in the fork control
    and do not decide the outcome.
  - `pending-agent-interaction.ts` and its unit test are fork-only, so that
    test is evidence but cannot discriminate upstream. The shipped
    `skills/paperclip/references/api-reference.md` changed upstream; the
    stage-handoff guidance must be merged into it, not replace it.
- **native-task-bound-continuation.** (stage 8, founder comment `19a7f568`)
  - Reproduced from STA-22 round 8 native records. Coordinator comment
    `cd8268d7` landed while the task was Done, so by design it woke nobody.
    A separate PATCH reopened it `done -> in_progress` with the same
    assignee, which also woke nobody: only `closed -> todo` did. The
    stranded sweep then dispatched `issue_disposition_repair` run
    `9dab77f6` (recovery action `774502e5`) against the previous stage's
    run `0bf7baf2`, saying it ended without a recorded disposition although
    it had recorded Done. The reviewer's hand-back of that notice got 409.
  - The fix takes the stage boundary from the structured issue audit trail:
    the run's own last `issue.updated` row (`run_id`, `details.status`)
    and later status transitions (`details.changes.status` or
    `details._previous.status`). It does not read summary prose for this.
  - Upstream fails all 12 required tests, all by assertion. The upstream
    passes include every negative control: a run that left its own stage
    active is still repaired, a pending human question still parks, a
    summary written within the current stage still parks.
  - The real-Postgres file loads unchanged on upstream. The route cases run
    through a port of upstream's own harness (`ports/native-task-bound-continuation/PORT.md`).
    The first port kept upstream's whole file; two upstream-only tests in it
    failed in the fork control (`62a6a6d4`, unknown), so the port was
    narrowed in `cf1c70a6`. That first attempt's upstream receipt was also
    `upstream-fails`, 12 of 12 (`947437c3`).
  - Not reproduced, so not changed: the 404 loop on settled recovery
    actions, and success reported from an unbound heartbeat. STA-38 run
    `912dd07d` was a caller-supplied `POST /agents/:id/wakeup`
    (`on_demand`, `triggerDetail: recovery_handoff`) with no task; the
    server made it company-scoped and denied its task writes, which is the
    fail-closed outcome. Review Done waking the same Engineer works natively
    (`issue_children_completed` on STA-21) and has existing coverage.
  - **R7 (STA-22 round 9), fixed in `6e5f6590`.** A queued run's summary
    snapshot (top-level or in the wake payload) carried only body and time,
    so its writer was unknown and that writer's own later status write
    unparked the executor; the adapter could also mix one container's body
    with the other's time. Both producers now record `documentId` and
    `revisionId`. The adapter reads one container, else the live document,
    and one predicate takes body, time and writer from that revision of this
    issue's continuation summary. Missing, malformed, foreign or mismatched
    identity, or a revision with no writer run, keeps the park.
  - R7 receipts: upstream fails 20 of 49 required, all by assertion. Its R7
    failures are the other-actor positives, the queued-body substitution
    and the three producers. Upstream passes the fail-closed R7 negatives
    because it never unparks on a stage change at all. 26 R7 cases fail by
    assertion on `e8bb1484` and pass with the fix. The stage-8 receipts
    (`9b60e519`, `d9a5ed46`) stay as history.
  - **Stage 9 (FAC-760 STA-43), fixed in `37b2bf5b`.** A dispatch-gate
    cancellation cleared the issue execution lock without re-draining the
    deferred queue, a deferred addressed-card wake outlived its invitation
    and spent the one promotion, and the gate reported the lost invitation
    as `issue_assignee_changed`. The gate cancellation now re-drains in a
    drain-only mode, the release retires a deferred `interaction_pending`
    wake whose invitation left `pending`, and the gate reports
    `interaction_no_longer_pending`.
  - Stage-9 receipts: upstream fails 29 of 58 required, all by assertion,
    including all 9 stage-9 cases and the single-pending-card control:
    upstream's gate has no addressed-card admission, so it cannot dispatch
    an addressed Coordinator at all. Upstream's own stranded-queue sweep
    covers assignee or mention wakes with queued comments or interaction
    responses, not a pending card's addressee. The 9 cases fail by
    assertion on `748e0901` and pass with the fix. The R7 receipts
    (`21ff918f`, `1573b468`) stay as history.
  - **Stage 10 (STA-22 round 11, R8), fixed in `010c5180`.** The gate's
    re-drain ran in a separate transaction after the cancellation committed,
    so a lost or failed drain stranded the live addressed wake, and the
    restart sweep never revisits a non-assignee addressee. The cancellation
    now commits a drain intent naming the deferred wakes; the post-commit
    drain and the restart sweep consume it under the issue lock, drain only
    those wakes, and settle it only from the persisted outcome.
  - Stage-10 receipts: upstream fails 45 of 76 required, all by assertion,
    including 16 of the 18 R8 cases (upstream has neither the re-drain nor
    an intent; its gate also never dispatches an addressed Coordinator). The
    13 R8 regressions fail by assertion on `64c07ec0` and pass with the fix.
    The stage-9 receipts (`f2d73334`, `60f6770e`) stay as history.
  - **Stage 11 (STA-22 round 12, R9), fixed in `71bf3065`.** The release
    kept only the intent from its locked re-read of the run row; Stop, the
    queue-interrupt override, the never-started exemption, the snapshot and
    settlement came from an earlier unlocked read, so a Stop committed in
    between was ignored. The locked row is now the only source for all of
    them; if its status or task changed, a pending intent stays pending.
  - Stage-11 receipts: upstream fails 56 of 88 required, all by assertion.
    Its 11 failing R9 cases fail at setup: upstream writes no drain intent,
    so there is nothing for a lost drain to leave pending. The 10 R9
    regressions fail by assertion on `32a1b64e` and pass with the fix. The
    stage-10 receipts (`8fc21461`, `93333a9f`) stay as history.
  - Carried on this branch as five self-contained server commits
    (`53373965`, `6e5f6590`, `37b2bf5b`, `010c5180`, `71bf3065`), to be
    selected together onto the repair line for a later qualified
    installation.
- **controller-lease-loss-attribution.**
  - Stage 12 (FAC-760, card `6b2a12f5`). Two successful provider turns
    (`19befcbc`, `d79920b9`) were stored `cancelled` with source `unknown`.
    The legacy controller lease watchdog is the only host abort that records
    nothing, and the local adapters ignore the abort until completion. The
    live loss cause is unrecorded and stays unknown.
  - `8cf65148` ports upstream `8595efc2`'s typed attribution: closed cause and
    timings on the abort reason, cancellation source `controller_lease`. The
    outcome stays `cancelled` and a recorded Stop keeps precedence. Not
    carried: upstream's private liveness pool, statement-timeout retry and
    pre-dispatch `controller_lease_lost` code.
  - Receipts: upstream passes 28/28, so upstream covers the behavior; the
    fork commit is carried until the combined candidate replaces it. Two
    earlier upstream attempts were `unknown` from fork-only fixtures (no
    company membership for the responsible user; fake databases without
    `transaction`); they are kept in the evidence bundle.
- **native-self-wake-suppression.**
  - Stage 13 (FAC-760, card `b098958d`). STA-33's assignee re-blocked its own
    task on a Done blocker with itself as unblock owner, and both the
    restored-dependency wake and the unblock notification re-woke it.
  - `1947665a` ports upstream's `shouldWakeOnRestoredBlockedDependency` and
    `wasBlockedByAssigneeAgent` byte-identically, with upstream's backstop
    cases, and adds the fork rule that the notification skips a writer that
    named itself owner. Agents may only name themselves as owner.
  - Receipts: upstream fails only the three cases that reach the notification;
    it passes the restored-path case. Retiring needs upstream to stop
    notifying a self-named writer.
- **native-comment-redelivery.**
  - Stage 13. Deferred comment wakes were replayed one run each after the
    finishing run had already started with those comments.
  - `484c0954` uses the finishing run's persisted execution envelope (id and
    `updatedAt`) and its `startedAt` as the delivery record, for ordinary
    comment wakes of a succeeded run on the same task and agent only.
  - Limit: delivery means the comment was in the envelope persisted for that
    run; an adapter that sends a fixed prompt still lets the agent read the
    task, but this is not proof that the provider read every comment.
  - Correction `7ada55ee`: exact-head CI on `2ea4c7d2` failed
    heartbeat-process-recovery "resumes only the authorized pending queue
    after an acknowledged legacy interrupt". After a queued-comment interrupt
    the successor turn is scoped to the selected queue, but its envelope lists
    the whole history, so `484c0954` retired the other actor's queue. A run
    dispatched from an authorized interrupt (same agent; a run's
    `queuedCommentInterruptQueueId` names its `wakeupRequestId`) now delivers
    nothing for this rule. Upstream passes that new case only because it has
    no delivered-comment check at all.
- **recovery-fixture-isolation.**
  - The fix changes only a test fixture. Upstream's copy of
    "keeps an explicit local-path/worktree conflict blocked…" still creates
    its workspace under `os.tmpdir()`, so the shared-ancestor problem remains
    upstream. Re-apply the one-line fixture change to upstream's changed file.
- **trusted-ci-baseline.**
  - The combined candidate needs `pr.yml` pinned to the reviewed upstream
    workflow at the candidate's upstream SHA.
  - It also needs the `maintenance upgrade toolkit` job, and a re-reviewed
    `requiredCiJobs` set for that CI shape.

## Migration inventory (static, `migration-inventory`)

`node maintenance/upgrade/cli.mjs migration-inventory --base 1b4c8038 --candidate 8595efc2`:

- **Scope:** 84 new migrations and 393 statements. Nothing is destructive: no
  drops, renames, type changes or truncation. The fork (`b2385913`) adds no
  migrations beyond stable.
- **Additive (311):** new tables, their indexes and constraints, nullable or
  defaulted columns, and 33 function definitions.
- **Previous-payload risk (76):**
  - 21 triggers added to existing tables and 15 dropped or re-created.
  - 13 dropped constraints and 7 dropped indexes, which may be ON CONFLICT
    targets.
  - 10 foreign keys, 10 checks and 7 unique indexes added to existing tables.
  - 1 dropped NOT NULL.
  - 4 procedural blocks.
- **Data rewrite (6):** UPDATE/INSERT on existing tables (`agents`,
  `resource_lifecycle_events`, `principal_permission_grants`,
  `cases`/`case_events`, `native_run_finalizations`, `heartbeat_runs`).
- **Affected existing tables:** 29, including `issues`, `heartbeat_runs`,
  `agents`, `activity_log` and `instance_settings`.

Running the previous payload against this schema is therefore **not assumed
safe**. New triggers on `issues`, `agents` and `activity_log` fire on the old
payload's writes, and new constraints can reject them. This is static evidence
only. Until an isolated migrated copy proves the previous payload works, the
`rollback-schema-compatible` gate must resolve to the owner-controlled recovery
stop, not automatic package rollback.
