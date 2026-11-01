/**
 * Durable drain intent for a run the queued-run claim gate cancelled.
 *
 * The gate commits the cancellation (and clears the issue lock the run was
 * promoted into) in its own transaction; the deferred queue behind that lock is
 * drained in a separate release transaction. The intent is written in the same
 * transaction as the cancellation, so a lost or failed drain is retried by the
 * restart sweep instead of stranding the next wake, including a wake for a
 * non-assignee addressee. It authorizes re-evaluation of the exact deferred
 * wakes it names through the normal release admission only: never a replay of
 * the cancelled run, and never later or unrelated work.
 *
 * Stored on the cancelled run as `resultJson.gateCancellationDrain`.
 */
export const GATE_CANCELLATION_DRAIN_KEY = "gateCancellationDrain";

export type GateCancellationDrainState =
  /** Not yet settled: drain still owed, or held by an admission gate. */
  | "pending"
  /** An exact successor was promoted, or none of the snapshot wakes is still deferred. */
  | "settled"
  /** Another execution holder owns the drain of the same queue. */
  | "superseded"
  /** The stored identity does not match the run it is stored on; never acted on. */
  | "invalid";

export type GateCancellationDrainIntent = {
  version: 1;
  state: GateCancellationDrainState;
  issueId: string;
  /** Deferred wakes on the issue when the cancellation committed: the only wakes this intent may drain. */
  deferredWakeIds: string[];
  /** The cancelled run had started an earlier attempt: its effects are unknown and it never gets the drain-only exemption. */
  providerWorkStarted: boolean;
  cancelledErrorCode: string;
  recordedAt: string;
  outcome?: "promoted" | "exhausted" | "lock_holder" | "malformed";
  successorRunId?: string;
  successorWakeId?: string;
  supersededByRunId?: string;
  heldAt?: string;
  heldReason?: string;
  evaluations?: number;
  settledAt?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildGateCancellationDrainIntent(input: {
  issueId: string;
  deferredWakeIds: string[];
  providerWorkStarted: boolean;
  cancelledErrorCode: string;
  now: Date;
  /** A different run holds the issue lock: its release owns this queue. */
  lockHolderRunId: string | null;
}): GateCancellationDrainIntent {
  const base = {
    version: 1 as const,
    issueId: input.issueId,
    deferredWakeIds: input.deferredWakeIds,
    providerWorkStarted: input.providerWorkStarted,
    cancelledErrorCode: input.cancelledErrorCode,
    recordedAt: input.now.toISOString(),
  };
  if (input.deferredWakeIds.length === 0) {
    return { ...base, state: "settled", outcome: "exhausted", settledAt: base.recordedAt };
  }
  if (input.lockHolderRunId) {
    return { ...base, state: "superseded", outcome: "lock_holder", supersededByRunId: input.lockHolderRunId, settledAt: base.recordedAt };
  }
  return { ...base, state: "pending" };
}

/**
 * Reads the intent stored on `run`. `malformed` when an intent is present but
 * its shape or identity does not match this run; null when there is none.
 */
export function readGateCancellationDrainIntent(run: {
  status: string;
  resultJson: Record<string, unknown> | null;
  contextSnapshot: Record<string, unknown> | null;
}): { kind: "none" } | { kind: "malformed"; raw: unknown } | { kind: "intent"; intent: GateCancellationDrainIntent } {
  const raw = run.resultJson?.[GATE_CANCELLATION_DRAIN_KEY];
  if (raw === undefined || raw === null) return { kind: "none" };
  if (typeof raw !== "object" || Array.isArray(raw)) return { kind: "malformed", raw };
  const intent = raw as Record<string, unknown>;
  const contextIssueId = typeof run.contextSnapshot?.issueId === "string" ? run.contextSnapshot.issueId : null;
  const wakeIds = intent.deferredWakeIds;
  const wellFormed =
    intent.version === 1 &&
    typeof intent.state === "string" &&
    ["pending", "settled", "superseded", "invalid"].includes(intent.state) &&
    typeof intent.issueId === "string" && intent.issueId === contextIssueId &&
    Array.isArray(wakeIds) && wakeIds.every(id => typeof id === "string" && UUID.test(id)) &&
    typeof intent.providerWorkStarted === "boolean" &&
    run.status === "cancelled";
  if (!wellFormed) return { kind: "malformed", raw };
  return { kind: "intent", intent: intent as unknown as GateCancellationDrainIntent };
}
