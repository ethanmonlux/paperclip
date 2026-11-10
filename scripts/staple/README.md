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

Gate 0 installs a master commit only when its CI is `green`. It reads the check runs and workflow
runs for that exact SHA. A job still queued or in progress is `pending`: nothing is installed, the
log records `pending, retry`, and the next watcher check tries again (STA-224). A completed failure,
`cancelled`, `timed_out`, `startup_failure` or `action_required` is `red`. No check runs is `none`,
and an unreadable or truncated GitHub response is `error`. Each of these blocks the install. To
classify saved GitHub responses, run `staple-nightly-upgrade ci-state CHECKS.json WORKFLOWS.json`.
It has no side effects.

Activation is outside agent runs: copy the script to `~/.local/bin/staple-nightly-upgrade`, and add
the 02:30 trigger, either the `systemd/` units or an equivalent cron line
(`30 2 * * * ~/.local/bin/staple-nightly-upgrade hold`).
