# Local worker memory boundary

This opt-in instance configuration uses the existing Claude local adapter
`filesystemSandboxCommand` extension. It does not change model, permissions,
workspace mounts, network policy, controller limits, or database limits.

Install the slice in the service user's systemd user directory, reload the user
manager, and start it. Install the executable wrapper at a stable user-owned path.
Set only the intended agents' `adapterConfig.filesystemSandboxCommand` to that path.
The wrapper refuses to execute unless the aggregate slice has the expected limits.

Each sandbox receives a 4 GiB hard memory limit and no swap; all such sandboxes
share an 8 GiB hard limit. The controller and database must remain outside this
slice. The aggregate limit can kill a worker when several are busy. Preserve
its task and reconcile effects through normal recovery before continuation.

Use the upstream low-memory typecheck command for this repository. TypeScript 7
is native and Node heap flags cannot bound it. Never set
`PAPERCLIP_TSC_EMIT_ONLY=1` for validation. It is only for packaging previously
typechecked source. A killed build is containment evidence, not a successful build.

Rollback: remove the adapter override through the agent configuration API for
future runs. Do not stop the slice while a worker owns an active task.
Retain the wrapper and slice until every already-started scope has ended.

Qualification on Linux with the real adapter subprocess helper:
- exact stdout, stderr and exit 17 preserved;
- scope memory.max 4294967296 and parent memory.max 8589934592 verified;
- timeout and explicit process-group cancellation removed sandbox descendants;
- simulated controller SIGKILL removed the worker scope;
- missing user bus failed closed before the test command ran.

These checks qualify process boundaries. Live task delivery and same-task recovery
remain separate acceptance obligations.
