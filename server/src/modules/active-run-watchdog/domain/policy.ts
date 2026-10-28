export type RunSilenceTimestamps = {
  lastOutputAt: Date | null;
  processStartedAt: Date | null;
  startedAt: Date | null;
  createdAt: Date | null;
};

export type SilenceLevel = "not_applicable" | "ok" | "snoozed" | "suspicious" | "critical";

export type ClassifySilenceLevelInput = {
  isRunningRun: boolean;
  silenceAgeMs: number | null;
  dismissedFalsePositive: boolean;
  snoozed: boolean;
  suspicionThresholdMs: number;
  criticalThresholdMs: number;
};

/**
 * Picks the timestamp the silence clock started counting from. The order is
 * the last output time, then the process start time, then the run start
 * time, then the run creation time.
 */
export function silenceStartedAt(run: RunSilenceTimestamps): Date | null {
  return run.lastOutputAt ?? run.processStartedAt ?? run.startedAt ?? run.createdAt ?? null;
}

export function silenceAgeMs(run: RunSilenceTimestamps, now: Date): number | null {
  const startedAt = silenceStartedAt(run);
  return startedAt ? Math.max(0, now.getTime() - startedAt.getTime()) : null;
}

export function classifySilenceLevel(input: ClassifySilenceLevelInput): SilenceLevel {
  if (!input.isRunningRun) return "not_applicable";
  if (input.dismissedFalsePositive) return "not_applicable";
  if (input.snoozed) return "snoozed";
  const age = input.silenceAgeMs ?? 0;
  if (age >= input.criticalThresholdMs) return "critical";
  if (age >= input.suspicionThresholdMs) return "suspicious";
  return "ok";
}

export type SuppressionSignals = {
  snoozedOrContinued?: boolean;
  recoveryOriginSource?: boolean;
  blockedSource?: boolean;
  dismissedFalsePositive?: boolean;
};

export type SuppressionReason =
  | "snoozed"
  | "recovery_origin_source"
  | "blocked_source"
  | "dismissed_false_positive";

export type SuppressionResult =
  | { suppressed: false }
  | { suppressed: true; reason: SuppressionReason };

/**
 * Decides whether a signal on a silent active run suppresses recovery work.
 * The caller passes only the signals it has resolved at its call site; an
 * unresolved signal must be left `undefined`, not `false`, so this function
 * checks each rule in a fixed priority order and returns the first match.
 */
export function evaluateSuppression(signals: SuppressionSignals): SuppressionResult {
  if (signals.snoozedOrContinued) return { suppressed: true, reason: "snoozed" };
  if (signals.recoveryOriginSource) return { suppressed: true, reason: "recovery_origin_source" };
  if (signals.blockedSource) return { suppressed: true, reason: "blocked_source" };
  if (signals.dismissedFalsePositive) return { suppressed: true, reason: "dismissed_false_positive" };
  return { suppressed: false };
}

export function isTerminalIssueStatus(status: string | null | undefined): boolean {
  return status === "done" || status === "cancelled";
}

/**
 * One silent active run's evidence, as the scan already resolves it. Every
 * field is a read the scan performs today; this decision adds no new query.
 */
export type StaleRunEvaluationEvidence = {
  /** The silence classification for this run. */
  level: SilenceLevel;
  /** The first suppression rule that matched, if any. */
  suppression: SuppressionResult;
  /** An open evaluation already bound to this run owns the escalation. */
  hasOpenEvaluation: boolean;
  /** The task the run was working. Without one there is nothing to evaluate. */
  sourceIssueId: string | null;
  /** The source task's status, used to leave settled work alone. */
  sourceIssueStatus: string | null;
};

export type StaleRunEvaluationSkipReason =
  | "not_running"
  | "within_critical_threshold"
  | "suppressed"
  | "evaluation_already_open"
  | "no_source_issue"
  | "terminal_source_issue";

export type StaleRunEvaluationDecision =
  | { open: false; reason: StaleRunEvaluationSkipReason }
  | { open: true };

/**
 * Decides whether a silent active run has earned a fresh stale-run
 * evaluation. The scan finds candidates at the *suspicion* threshold, which
 * is deliberately low, and today it does nothing with one that has no open
 * evaluation: `scanSilentActiveRuns` only ever counts an evaluation that
 * already exists, so its `created` and `escalated` counters never move and a
 * run that goes quiet with no prior evaluation is skipped forever.
 *
 * Opening an evaluation is board-visible work, so this decision is the
 * conservative half of that repair and requires the *critical* level rather
 * than mere suspicion. The clause order encodes the precedence: liveness
 * first, then the bound, then the suppression rules the scan already honours,
 * then ownership by an existing evaluation, and only then the source task.
 *
 * It is a pure decision and authorizes nothing by itself: the caller still
 * owns creating at most one evaluation per run, bound to that run's identity.
 */
export function decideStaleRunEvaluation(
  evidence: StaleRunEvaluationEvidence,
): StaleRunEvaluationDecision {
  // "not_applicable" covers a run that is no longer running and a run whose
  // silence an operator already dismissed as a false positive.
  if (evidence.level === "not_applicable") return { open: false, reason: "not_running" };
  // Suspicion alone is not an escalation. Snoozed silence is also still inside
  // a bound somebody chose, so it waits for the critical level like any other.
  if (evidence.level !== "critical") return { open: false, reason: "within_critical_threshold" };
  // The scan's own suppression rules keep their meaning at the critical level.
  if (evidence.suppression.suppressed) return { open: false, reason: "suppressed" };
  // An open evaluation is the existing owner of this run's silence. A second
  // one would duplicate the effect this decision exists to create exactly once.
  if (evidence.hasOpenEvaluation) return { open: false, reason: "evaluation_already_open" };
  // A run with no source task has no work to evaluate and nowhere to return.
  if (!evidence.sourceIssueId) return { open: false, reason: "no_source_issue" };
  // Settled work needs no evaluation. The fold path, not this one, reconciles a
  // terminal source whose run is still marked running.
  if (isTerminalIssueStatus(evidence.sourceIssueStatus)) {
    return { open: false, reason: "terminal_source_issue" };
  }
  return { open: true };
}

export type ShouldFoldTerminalSourceInput = {
  sourceIssueStatus: string | null | undefined;
  hasSameRunTerminalEvidence: boolean;
};

/**
 * A terminal source issue folds the watchdog run only when durable,
 * same-run evidence shows the issue already reached that terminal status
 * from an action inside this run. A terminal status alone is not enough
 * evidence; a different run or a different actor could have closed it.
 */
export function shouldFoldTerminalSource(input: ShouldFoldTerminalSourceInput): boolean {
  return isTerminalIssueStatus(input.sourceIssueStatus) && input.hasSameRunTerminalEvidence;
}
