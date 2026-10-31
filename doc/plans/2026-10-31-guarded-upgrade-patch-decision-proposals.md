# Guarded upgrade: proposed patch decisions for independent review

Owner: FAC-760 / STA-21. These are **proposals**. The committed registry keeps
every decision `unassessed` until an independent reviewer accepts or changes
each one against the cited receipts. A proposal is not a decision.

Inputs:

- Upstream candidate `8595efc20bda3ce20a9fbbf34a5d156a6fcf6d57` (tree `772753c6`).
- Fork source: live PR #10 head and PR #11 base `b2385913e0f2048af05a3a60a0e4515528c7cb07`
  (stage 3 used `5305f21c`; the receipts below were re-run against `b2385913`).
- Harness and ports at commit `113b51bf66110d83c22262b66ddc914a0c615a07`.
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
| github-launcher-run-scope | unknown 4/4 non-assertion (`a31e7c0b`) | passes 4/4 | `execution-target.ts`/`execute.ts` changed; helper absent | **adapt** |
| claude-terminal-cleanup | unknown 19/35 non-assertion (`aca9475c`) | passes 35/35 | `execute.ts`/`server-utils.ts` changed; `parse.ts` identical | **adapt** |
| native-handoff-admission | unknown: 7/9 fail, 5 assertions and 2 timeouts (`c1f0e898`) | passes 9/9 (file 121/121) | `policy.ts` identical; `postgres.ts`, `issue-thread-interactions.ts`, `api-reference.md` changed; `pending-agent-interaction.ts` absent | **adapt** |
| recovery-fixture-isolation | unknown, manual (`fb53e68c`) | n/a | test file changed; upstream fixture still under `os.tmpdir()` | **adapt** (test-only) |

No patch is proposed for retirement. Upstream-only evidence does not show that
upstream covers any of these behaviors.

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
- **github-launcher-run-scope / claude-terminal-cleanup.**
  - Both receipts are `unknown` because the unit tests import helpers that
    exist only in the fork (`localGitHubLauncherSandboxPaths` and the
    latest-turn parser).
  - In the same run, the Codex-level assertion "passes this run's managed
    GitHub launchers into the local sandbox" fails on upstream.
  - A reviewer should accept or reject the source evidence explicitly.
    Admission still requires a cited receipt for each decision.
- **native-handoff-admission.**
  - Upstream fails 5 of the 9 required tests with assertions: the policy
    still reports the addressed participant's wake as stale, the Postgres
    adapter cancels the persisted handoff and denies the pending-invitation
    retry. The other two required failures are 15 s timeouts in the
    concurrent cancellation and stale-expiry ordering tests, so the strict
    classifier reports `unknown`, not `upstream-fails`.
  - Three tests outside the required set fail only upstream, on a
    `budget_reservations ... for update` query. They pass in the fork control
    and do not decide the outcome.
  - `pending-agent-interaction.ts` and its unit test are fork-only, so that
    test is evidence but cannot discriminate upstream. The shipped
    `skills/paperclip/references/api-reference.md` changed upstream; the
    stage-handoff guidance must be merged into it, not replace it.
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
