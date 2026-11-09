import { isResolvedInteractionContinuationWakeContext } from "../../modules/run-dispatch/domain/wake-context.js";

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

/**
 * An addressed-interaction wake (a pending card's addressee, or a resolved
 * interaction's continuation) retries only through the interaction lane: it
 * keeps `interaction_pending` so dispatch still admits a non-assignee
 * addressee, and it stops once the card is no longer pending.
 */
export function isInteractionOwnedWake(contextSnapshot: unknown) {
  const context = typeof contextSnapshot === "object" && contextSnapshot !== null && !Array.isArray(contextSnapshot)
    ? contextSnapshot as Record<string, unknown> : {};
  return context.wakeReason === "interaction_pending" || isResolvedInteractionContinuationWakeContext(context);
}
