# git-install-payload upstream-only port

Original: `cli/src/__tests__/install-command.test.ts` at fork `5305f21c97a2dd3a77e529fb10778be48e8eeb02`.

Against upstream `8595efc2`, the original fixture crashed with
`ENOENT ... server/ui-dist/index.html` inside its fake `prepare-bundled-package`
step. Upstream never stages the UI, so the fixture's direct `readFileSync`
throws before its `expect` can run. The classifier correctly treats that as
`unknown`.

This port changes only how the fixture observes staged files. It adds no
behavior and removes no assertion:

- adds `readIfPresent`, so an absent staged file is read as `null`
- uses `expect.soft` for the staged UI/skills, the tarball contents and the
  staged workspace versions, so absence becomes an assertion failure and the
  later checks in the same test still run
- copies `ui-dist`/`skills` into the fake staged package only when they exist,
  rather than crashing

Every assertion of the original still runs, against the same expected values.
The harness records the port's blob, its sha256 and the original fork test's
blob in each receipt. The same port must pass against the fork source as the
control.
