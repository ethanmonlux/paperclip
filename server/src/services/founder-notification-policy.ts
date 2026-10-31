import type { AttentionItem } from "@paperclipai/shared";

/**
 * Founder phone notifications consume the server's own attention feed rather
 * than re-deriving founder state. The feed already excludes agent-addressed
 * routing cards, other users' cards, agent-owned recoveries and superseded
 * failed runs. This policy only decides which of those task-bound facts are
 * worth interrupting a phone for, and which must first persist.
 *
 * Inputs are closed, server-generated fields (source kind, dedup key prefix,
 * subject/related issue ids, snooze/dismissal state). Model prose, whyNow
 * copy and provider transcripts are never classification inputs.
 */
export type FounderNotificationClass =
  /** A typed decision or human-owned recovery: notify on first observation. */
  | "decision"
  /** May still recover automatically: notify only after the persistence bound. */
  | "stall";

export type FounderNotificationClassification =
  | { notify: true; kind: FounderNotificationClass; taskIssueId: string }
  | { notify: false; reason: FounderNotificationQuietReason };

export type FounderNotificationQuietReason =
  | "no_task_identity"
  | "out_of_scope_source"
  | "recipient_snoozed"
  | "recipient_dismissed"
  | "archived";

export const FOUNDER_NOTIFICATION_STALL_AFTER_MS_DEFAULT = 15 * 60_000;
export const FOUNDER_NOTIFICATION_STALL_AFTER_MS_MIN = 5 * 60_000;
export const FOUNDER_NOTIFICATION_STALL_AFTER_MS_MAX = 24 * 60 * 60_000;
/** A stall must be seen on at least two distinct ticks, never one sample. */
export const FOUNDER_NOTIFICATION_STALL_MIN_OBSERVATIONS = 2;

/**
 * Narrowing or lengthening is allowed; disabling the bound is not. Invalid
 * values fall back to the reviewed default instead of firing immediately.
 */
export function boundedStallAfterMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return FOUNDER_NOTIFICATION_STALL_AFTER_MS_DEFAULT;
  }
  return Math.min(
    FOUNDER_NOTIFICATION_STALL_AFTER_MS_MAX,
    Math.max(FOUNDER_NOTIFICATION_STALL_AFTER_MS_MIN, Math.trunc(value)),
  );
}

/** The original task the founder must act on, never a chat-bound task. */
export function founderNotificationTaskIssueId(item: AttentionItem): string | null {
  if (item.relatedIssue?.kind === "issue") return item.relatedIssue.id;
  if (item.subject.kind === "issue") return item.subject.id;
  return null;
}

function sourceClass(item: AttentionItem): FounderNotificationClass | null {
  switch (item.sourceKind) {
    case "issue_thread_interaction":
    case "approval":
    case "decision":
    case "review":
    case "recovery_action":
      return "decision";
    case "blocker_attention":
      // `blocked-owner:` is an explicit human-owned unblock request; a bare
      // `blocker:` chain is a stall the owner may still clear on its own.
      return item.dedupKey.startsWith("blocked-owner:") ? "decision" : "stall";
    case "failed_run":
      return "stall";
    default:
      // Company/agent-level alerts (budget, agent error, join requests) carry
      // no original task identity to pause, acknowledge and resume.
      return null;
  }
}

export function classifyFounderNotification(
  item: AttentionItem,
  now: number,
): FounderNotificationClassification {
  if (item.archivedAt) return { notify: false, reason: "archived" };
  const kind = sourceClass(item);
  if (!kind) return { notify: false, reason: "out_of_scope_source" };
  const taskIssueId = founderNotificationTaskIssueId(item);
  if (!taskIssueId) return { notify: false, reason: "no_task_identity" };
  if (item.snoozedUntil && Date.parse(item.snoozedUntil) > now) {
    return { notify: false, reason: "recipient_snoozed" };
  }
  if (item.dismissal?.isActive) return { notify: false, reason: "recipient_dismissed" };
  return { notify: true, kind, taskIssueId };
}

/**
 * Whether an observed episode has crossed its notification threshold. A
 * decision is due immediately; a stall needs both elapsed time since first
 * observation and more than one tick, so one stale sample never pages.
 */
export function founderNotificationDue(input: {
  kind: FounderNotificationClass;
  firstObservedAt: number;
  observations: number;
  now: number;
  stallAfterMs: number;
}): boolean {
  if (input.kind === "decision") return true;
  return (
    input.observations >= FOUNDER_NOTIFICATION_STALL_MIN_OBSERVATIONS &&
    input.now - input.firstObservedAt >= boundedStallAfterMs(input.stallAfterMs)
  );
}
