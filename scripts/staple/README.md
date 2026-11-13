# Staple managed upgrade

`staple-nightly-upgrade.sh` is the source of `~/.local/bin/staple-nightly-upgrade`, the only Staple
install path (FAC-840 C1). Agents never run, install or schedule it.

Nightly maintenance window:

| Time | Step |
| --- | --- |
| 02:30 | `staple-nightly-upgrade hold` places the maintenance hold. The server starts no new run; wakes, assignments and comments still queue. |
| 02:30–03:15 | Running runs finish. Runs still running at the drain deadline are parked with a queued continuation, never cancelled. Parking retries each minute until nothing is running or still settling. |
| 03:30 | `staple-nightly-upgrade` upgrades only when `GET` reports `quiet` (`blockingWork` 0: nothing running, no stop still settling, every parked run's continuation recorded): backup, install, restart, health and smoke checks, rollback on failure. |
| After | The script releases the hold after success or rollback. Held work starts in priority order, staggered across agents. |

The hold is stored in the database, so it survives the install restart. It lifts by itself at its
expiry (90 minutes after the last placement or renewal, and never more than 4 hours after it started)
even if the script dies. Only a board instance admin can place or release it: `POST` and
`DELETE /api/instance/maintenance-hold`. `GET` reports it, and the Staple Console shows a banner
while it is active.

The hourly `QUIET_MODE=1` run remains as a daytime path. It acts only after three zero-run checks,
and then holds the lull with a short hold.

Gate C installs only a certified commit (STA-223). A push to a pull request runs routine checks
only (see "Routine checks and nightly certification" below), so the nightly `staple-certify.yml`
run (22:45 Denver standard time, and `workflow_dispatch` on demand) builds one merged master commit
and runs the complete suite on it. It records the verdict as the commit status `staple/certified`
on that exact commit. The installer walks master's first-parent history,
newest first, and picks the newest commit certified `success`. A newer commit that is uncertified,
pending, failed or unreadable is skipped and logged. If the installed build is reached first, nothing
newer is certified and nothing happens. When no commit is certified, the installer fails closed. It
never installs a commit older than the installed build. After an urgent fix merges, dispatch
`staple-certify.yml` on master; once that certifies, the hourly quiet-window check installs it the
same day. `staple-nightly-upgrade certified-target [INSTALLED]` prints the current pick and has no
side effects.

Every upgrade and quiet-window check first reads the newest completed nightly run. A red run becomes
one critical (urgent-lane) task per failing suite, carrying the failing jobs, failed steps, annotation
excerpts and the commit. Each task goes to the Workflow Engineer, or to the Repair Engineer when the
Engineer is busy (`STAPLE_REPAIR_AGENTS`). Each run is reported once (`~/.paperclip/nightly/certify-reported`).
`staple-nightly-upgrade certify-report --dry-run [RUN_ID]` prints the tasks without creating them.

Gate 0 installs the certified commit only when its CI is `green`. It reads the check runs and workflow
runs for that exact SHA. A job still queued or in progress is `pending`: nothing is installed, the
log records `pending, retry`, and the next watcher check tries again (STA-224). A completed failure,
`cancelled`, `timed_out`, `startup_failure` or `action_required` is `red`. No check runs is `none`,
and an unreadable or truncated GitHub response is `error`. Each of these blocks the install. To
classify saved GitHub responses, run `staple-nightly-upgrade ci-state CHECKS.json WORKFLOWS.json`.
It has no side effects.

After the restart, Gate 3 waits up to 5 minutes for `/api/health` to report the target commit and for
the service journal to log `startup recovery complete` since the restart. The journal is read whole
before the match, because `journalctl | grep -q` under `pipefail` exits 141 when `grep` stops at an
early match. A journal that cannot be read is an error, never a pass. To check the journal by hand,
run `staple-nightly-upgrade startup-logged 'YYYY-MM-DD HH:MM:SS'`. It prints `logged`, `waiting` or
`error:<reason>` and has no side effects. An unknown argument exits 2 before any upgrade step.

Activation is outside agent runs: copy the script to `~/.local/bin/staple-nightly-upgrade`, and add
the 02:30 trigger, either the `systemd/` units or an equivalent cron line
(`30 2 * * * ~/.local/bin/staple-nightly-upgrade hold`).

## Missed-upgrade report

`staple-missed-upgrade.mjs` (STA-225) checks hourly whether an upgrade was missed. It only reads and
reports. It never installs, restarts, places a hold or takes the installer's lock, and it stays
silent from 02:15 to 04:30 while the nightly run works.

A report is due when either:
- the chosen commit was certified before the 03:30 run and is still not installed an hour after it
  (missed nightly), or
- a merged change has been uninstalled for two hours.

The chosen commit is the installer's own pick (`certified-target`), checked with the installer's
Gate 0 (`ci-state`). A Gate 0 `pending` is a CI wait: no report and no card, and the next check
looks again. An unreadable read is retried the same way. A completed red Gate 0 is reported as the
failure, and that commit is not recommended.

The report is one comment on the upgrade-log issue (STA-193, `report-issue-id`). It lists every
merged PR and upstream sync between the installed build and the chosen commit, then everything
merged after it that is not certified yet. Each item is classified from the Staple issues named in
its PR title or branch:

| Class | When |
| --- | --- |
| Critical | A linked issue is `critical`. |
| Valuable | A linked issue is `high`, or the change is an unlinked `fix`. It costs a day while that issue still blocks open work. |
| Can wait | Anything else, including `ci`, `test`, `chore` and `docs` changes. |

The report recommends upgrading now when a Critical or day-costly Valuable change is installable.
Otherwise it recommends waiting for tonight. Only then is a founder card raised: Upgrade now / Wait
for tonight, with each consequential change, the chosen commit, and the expected time (a drain of
up to 10 minutes plus about 10 minutes to back up, build, restart and verify). With no newer
certified commit there is no card. A Critical change then gets "certify master now".

One report and at most one card exist per (installed build, chosen commit) pair, across hourly
checks and restarts. The pair is the card's idempotency key and a marker in each report, answer and
update comment. `~/.paperclip/nightly/missed-upgrade-state.json` is only a cache. Each check first
rebuilds the pairs from the reporter's cards on the upgrade-log issue. It posts a comment only when
the comment's marker is not on that issue yet, reading every comment page to check. It adopts an
existing card by its key instead of raising it again. A lost state file, a crash between a POST and
its checkpoint, or a moved build therefore never repeats a comment or strands a card.

The answer is followed up once on the same issue:
- **Upgrade now** hands the install to the qualified operator, who runs
  `HOLD_DRAIN_MIN=10 ~/.local/bin/staple-nightly-upgrade`. If Staple has already moved past the
  card's installed build, the answer is recorded with no handoff.
- **Wait for tonight** leaves the install to the 03:30 run.
- A card still pending after Staple moves past its installed build is withdrawn.

If a pair's recommendation changes, one update comment gives the new one. For example, its CI turns
green and the card follows.

`--dry-run` prints the report and card without writing anything.

The script needs Node 20 or later. Set `STAPLE_GITHUB_TOKEN` (read-only) so the hourly GitHub reads
stay inside the API rate limit. Activation is outside agent runs: copy the script to
`~/.local/bin/staple-missed-upgrade.mjs` next to the installer, and enable the `systemd/`
`staple-missed-upgrade` units. They run at :45 past each hour, or use an equivalent cron line
(`45 * * * * node ~/.local/bin/staple-missed-upgrade.mjs`).

## Routine checks and nightly certification

Every push to a pull request, including a base refresh and an upstream-sync branch, runs routine
checks (`.github/staple-ci-scope.json`, `.github/scripts/staple-ci-scope.mjs`):

| Check | What it covers |
| --- | --- |
| `policy` | Policy and syntax checks, and the tests of the CI and installer scripts. |
| `Affected packages (typecheck)` | A typecheck of each workspace package the push changes and of every package that depends on it. A root manifest, lockfile or TypeScript configuration change typechecks every package. |
| Focused regression tests | The changed tests, the tests whose import graph reaches a changed source, and the tests that declare a changed file as an input (`scripts/ci/select-tests.mjs`). |
| Package-owned suites | The Runner checks, the Docker context check and the sandbox provider tests run only when their own paths change. |
| `verify` | The one stable aggregate. It passes when every planned check passed. |

The repository-wide build and typecheck, the browser e2e shards, the Runner support suite and the
canary dry run never run on a routine push. They run in the nightly certification. To run the
complete suite on one pull request, for a final candidate, add the `full-ci` label.

The focused selection is deliberately narrower than the complete selection. The complete selection
also keeps every test whose imports reach a filesystem, process or network module, because it
cannot prove such a test ignores the change. For a six-file server change that kept 1,723 of 1,903
server test files, although 39 import the changed files. A routine push runs the 39. The selection
job's summary and its `audit.json` artifact name what was left out and why:

- tests kept only for an opaque import, per project;
- changed files outside the test import graphs;
- changed sources that no selected test imports;
- affected tests that the chat or native Runner lanes own.

When the affected tests need more than `routine.maxTestJobs` jobs (a widely re-exported source
reaches most of the suite), the push runs the nearest tests that fit: the changed tests with the
direct importers of the changed sources, or only the direct importers named after or beside a
changed source, or the changed tests alone. The summary says which. `audit.json` lists each affected
test it left out as `budgetDeferred`. A changed setup file or Vitest configuration selects every
test of its project, and the budget never prunes that project. It never runs a near-complete suite and calls it light.

A new push cancels the superseded checks of the same pull request only (`pr.yml`). It never cancels
another pull request's checks or a certification. No workflow runs the same checks on both `push`
and `pull_request`. A merge does not require refreshing every open branch: only the next pull
request to integrate needs to be current with master.

A certification verdict always stands for the complete suite. Outside a pull request, the `verify`
aggregate fails if a plan narrowed the run or if any suite was skipped, failed or cancelled, and
`staple/certified` is `success` only when the whole run succeeded. A failed, cancelled or
incomplete certification leaves the installed build in place, and becomes repair tasks.
