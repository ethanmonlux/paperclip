# native-handoff-admission upstream-only port

Original: `server/src/modules/run-dispatch/adapters/postgres.test.ts` at fork
`b2385913e0f2048af05a3a60a0e4515528c7cb07`.

Against upstream `8595efc2`, two required tests timed out at the configured
15 s: "serializes concurrent invitation cancellation with the final provider
handoff" and "orders stale-target expiry issue-first against final invitation
dispatch". Both paused inside a `vi.mock` of the fork-only
`services/pending-agent-interaction.js`. Upstream never calls that module, so
the pause was never reached and the tests waited forever. The classifier
correctly reported `unknown`.

This port removes that mock. It does not import the production fix. Instead,
the two tests pause the real gate with row locks the test itself holds in
Postgres. Both implementations' gates (`withIssueThenRunLocks` /
`withRunOwnershipLocks`) take company, then issue, then run locks.

- **Cancellation:** a test transaction updates the invitation to `cancelled` and
  stays open. The gate starts, and the test waits until some backend is blocked
  by that transaction (`pg_blocking_pids`), and its query is a `select` on
  `issue_thread_interactions`. The test then commits, or rolls back:
  - commit: no dispatch
  - roll back: exactly one dispatch

  The unlocked predecessor of the fix, `00d786b6^`, reads the old pending row
  without waiting, so it fails the lock-wait assertion.
- **Expiry order:** a test transaction holds the run row. The gate then owns the
  issue lock and waits for the run lock, before it reads the invitation. The
  real human rejection (`rejectInteraction`, with stale-target expiry) starts,
  and the test waits for the backend blocked by the gate. That backend must be a
  `select ... "issues"` lock. The old order (`2a34dfba^`) instead blocks on
  `update "issues"` after locking the invitation, which deadlocks once the gate
  continues. After release, the original outcome assertions are unchanged.
- **Dispatch first** (added for STA-22 finding R6): the cancellation case above
  starts the revocation before the gate, so it shows the read waits, but not
  that the lock stays held from the read until the provider handoff. This case
  restores the original's schedule without the fork-only mock. A test-only seam
  wraps the `Db` passed to `createPostgresRunDispatchAdapter`. For every
  transaction opened through it, including savepoints, it observes each query
  after its result returns, and records whether that transaction is still open.
  Both trees use drizzle-orm 0.45.2, so the seam works the same on each. Only
  the adapter's public constructor and drizzle transactions are touched.
  - The seam pauses once, right after the locked (`for update`) read of this
    invitation, and records that transaction's backend pid.
  - The test then starts a cancellation of the invitation on the plain `Db`. It
    must wait on a `Lock` held by that pid, before anything is revoked.
  - After release, `dispatch` runs once, while the reading transaction is still
    open, and the order is `["dispatch", "revoked"]`.
  - A gate that never makes that read finishes, and the test fails on
    `reached`.

  Negative control: STA-22's early-unlock mutation (bundle `1db45340`) runs
  the same locked read in a separate root-`Db` transaction that commits before
  the decision returns. It is applied in memory by a Vite transform, with no
  repository bytes changed. Under it the lock-wait checks still pass, but the
  reading transaction is closed at dispatch, so this case fails by assertion.

The waits are bounded: each polls `pg_stat_activity` at most 300 times, 10 ms
apart, and returns early once the gate or the rejection settles. A gate that
never reaches the lock therefore completes and fails an assertion. The test
timeout stays the configured 15 s.

Run against `b2385913` with each fix reverted in a scratch tree, only the
matching test fails, by assertion. Production files were restored afterwards.

Every other test in the file is unchanged, including the negative cases:
accepted/cancelled invitation, changed recipient, execution lock, budget,
pause, dependency. Matching is now on blocking pids rather than query text,
because Postgres truncates long queries in `pg_stat_activity`.

The same port must pass against the fork source as the control.

Limit: the cases cover these finite schedules and the mutations named here. They
are not proof of every interleaving. For example, a lock released early by
rolling back a savepoint would leave the transaction open; there, only the
order assertion would catch it, and that depends on timing.
