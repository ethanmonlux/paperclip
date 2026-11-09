/**
 * FAC-840 wait contract: an unfinished crashed run gets a bounded retry.
 *
 * A run that failed with no adapter-specific code (`adapter_failed`) after the
 * adapter process exited 0 or was killed by a signal never produced a result:
 * it crashed (unparseable output, memory termination, a lost stream) rather
 * than reporting a failure. STA-153 ended this way with "Failed to parse
 * claude JSON output". Such a run takes the ordinary bounded transient retry
 * lane; once that budget is spent the run stays failed and visible.
 *
 * Named adapter codes (auth, model, quota, timeouts) and non-zero exits keep
 * their own handling, so a real configuration failure is never retried here.
 */
export function isUnfinishedAdapterCrashRun(run: {
  status?: string | null;
  errorCode?: string | null;
  exitCode?: number | null;
  signal?: string | null;
}) {
  if (run.status && run.status !== "failed") return false;
  if (run.errorCode !== "adapter_failed") return false;
  return run.exitCode === 0 || Boolean(run.signal);
}
