# claude-terminal-cleanup upstream-only port

Originals: `packages/adapters/claude-local/src/server/execute.terminal-cleanup.test.ts`
and `parse.terminal-cleanup.test.ts` at fork
`b2385913e0f2048af05a3a60a0e4515528c7cb07`.

Against upstream `8595efc2`, 16 of the 19 failures were
`createClaudeTerminalResultTracker` / `hasCurrentClaudeTerminalResult is not a
function`: the parse tests call those fork-only helpers directly, and the
real-process execute tests pass the tracker to `runChildProcess` themselves. The
classifier correctly reported `unknown`.

These ports observe the same behaviours through the real `execute()` wiring.
A scripted fixture provider (`#!<node>` script written per test) emits the same
stream-json records with the same ordering and timing as the original, as a real
child process. `runAdapterExecutionTargetProcess` delegates to the real
implementation for those cases, so the adapter's own terminal-result cleanup
options (upstream: `hasTerminalResult` only; fork: the latest-turn tracker)
decide the outcome. No fork helper is imported.

`execute.terminal-cleanup.test.ts`:

- every mocked-process test is unchanged
- the seven real-process tests keep their titles. Each now runs its original
  script through `execute()` and asserts the original expectations on the
  adapter result:
  - result fields (`exitCode`, `signal`, `errorCode`, `errorMessage`,
    `errorFamily`, `retryNotBefore`, `summary`, `adapterCompletion`)
  - the persisted cleanup evidence (`resultJson.unmanagedBackgroundTask`), in
    place of the in-test `proc.terminalResultCleanup`
  - stdout/stderr text, through the `onLog` stream
- behavioural assertions are checked before the evidence-field assertions
- dropped: one capture-evicted assertion, that the controller's stdout no longer
  contains the result frame. That is controller-internal capture state that
  `execute()` does not expose; the reconciliation disposition it supported is
  still asserted

`parse.terminal-cleanup.test.ts`:

- the seven tracker tests keep their titles. Each original chunk sequence
  becomes a fixture that writes those chunks, then lingers or exits
- each asserts the effect the tracker's answer has on cleanup:
  - a current result: cleanup stops the process and the result is normalized
  - a stale result: cleanup is cancelled and the fixture's own exit code is
    reported
  - a later result: that result's summary is reported

Timings: cleanup grace is 200 ms (1500 ms for the whitespace case, which has to
write 12 MiB before its assistant record). Later turns arrive 700 ms after the
first result and exits happen at 700 ms or later. Each fixture also exits on its
own after 6 s, and each real-process test has a 10 s completion bound. These
bounds make sure a test finishes; they do not decide the outcome.

The same ports must pass against the fork source as the control.
