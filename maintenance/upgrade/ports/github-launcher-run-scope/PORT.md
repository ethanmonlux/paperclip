# github-launcher-run-scope upstream-only port

Original: `packages/adapters/codex-local/src/server/execute.test.ts` and
`packages/adapter-utils/src/github-launcher-sandbox.test.ts` at fork
`b2385913e0f2048af05a3a60a0e4515528c7cb07`.

Against upstream `8595efc2`, the three helper tests in
`github-launcher-sandbox.test.ts` failed with `localGitHubLauncherSandboxPaths is
not a function`: they call the fork-only helper directly, so upstream cannot run
them. The classifier correctly reported `unknown`.

This port moves those behaviours to the boundary upstream and the fork share,
the Codex adapter's real `execute()`, and observes every directory it hands to
the local process sandbox (`managedPaths` and `extraPaths` of every
`runChildProcess` call). It does not import the fork helper or any production
code beyond what the original file already imported.

It is the fork's `execute.test.ts`, unchanged except:

- `runTeardown` takes an optional `launcherEnvDir`, the configured
  `PAPERCLIP_GITHUB_LAUNCHER_DIR` value
- `symlink` is imported
- five tests are added:
  - an arbitrary configured directory is never mounted
  - another run's canonical directory is never mounted
  - a symlink at this run's canonical path is never mounted, and neither is its
    target. `execute()` may reject; the test only requires that nothing it does
    not own is mounted
  - this run's canonical directory is mounted read-write
  - this run's broker capability variable name reaches the Codex shell policy
    while its value never appears in argv

Every original test and assertion in the file is unchanged. The registry entry
now runs only this file; `github-launcher-sandbox.test.ts` stays in
`evidencePaths` and in fork CI, but cannot discriminate upstream.

Not covered: the fork also mounts the launcher directory in the Claude adapter.
No evidence file observes that path, so it stays a combined-candidate item.

The same port must pass against the fork source as the control.
