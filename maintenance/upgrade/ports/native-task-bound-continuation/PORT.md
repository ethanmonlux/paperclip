# Port: native-task-bound-continuation (route reopen wake)

Observation-only. This port changes no product code.

## Why a port

The fork's `server/src/__tests__/issue-update-comment-wakeup-routes.test.ts`
mocks the route's service graph as it exists on the fork. Upstream `8595efc2`
changed that harness (activity-log, execution-blocker and external-object mocks,
a `beforeAll` module load and a `select` stub). Overlaying the fork file onto
upstream would fail on mocks, not on behaviour, and the harness would correctly
call that `unknown`.

## What the port is

`issue-update-comment-wakeup-routes.test.ts` here is the first 355 lines of
upstream's own file at `8595efc2`, byte-for-byte: imports, mocks, the
`createApp`/`makeIssue` harness, the `beforeAll`/`beforeEach` setup and its
first three tests (pause rejection, assignment-only update on completed work,
explicit reopen to todo). The fork also has those three, so they are harness
sanity checks. After them come only the fork's two new cases, then the
closing brace:

- `wakes the same assignee when another actor reopens %s work directly to in_progress`
  (`done`, `cancelled`): a `PATCH` from `done`/`cancelled` to `in_progress` with
  an unchanged agent assignee must enqueue one `issue_status_changed` wake.
- `does not wake an in_progress task whose status did not change`: negative control.

Upstream's remaining tests are left out on purpose. An earlier version of this
port kept the whole upstream file; two upstream-only tests in it
(`saves a %s comment without promoting a workspace-held task to Todo`) cover
an upstream guard the fork does not have, so they failed in the fork control
and made the control `unknown` for reasons unrelated to this patch.

Check with:

```sh
P=maintenance/upgrade/ports/native-task-bound-continuation/issue-update-comment-wakeup-routes.test.ts
diff <(git show 8595efc2:server/src/__tests__/issue-update-comment-wakeup-routes.test.ts | head -355) <(head -355 "$P")
```

## Limits

- The route harness is mocked (no database). The real-Postgres evidence for the
  same defect family is `server/src/__tests__/native-task-bound-continuation.test.ts`,
  which loads unchanged on upstream and needs no port.
- The port asserts the wake request only. That the queued wake then runs as a
  normal task-bound execution is covered by the existing dispatch tests, not here.
