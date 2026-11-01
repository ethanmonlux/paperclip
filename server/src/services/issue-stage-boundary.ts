import { and, desc, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";

const ACTIVE_ISSUE_STATUSES = new Set(["todo", "in_progress"]);

/**
 * Issue stage boundaries come from the structured issue audit trail, not from
 * summary prose. Every issue status writer logs `issue.updated` with the
 * requested `details.status`; route writes add `details.changes.status` and
 * recovery writes add `details._previous.status`.
 */
const STATUS_TRANSITION = sql`(
  ${activityLog.details} -> 'changes' ? 'status'
  or (${activityLog.details} -> '_previous' ? 'status'
    and ${activityLog.details} -> '_previous' ->> 'status' is distinct from ${activityLog.details} ->> 'status')
)`;

/** The last issue status a run itself requested, or null when it wrote none. */
export async function readRunRecordedIssueStatus(
  db: Db,
  input: { companyId: string; issueId: string; runId: string },
): Promise<string | null> {
  const [row] = await db
    .select({ status: sql<string | null>`${activityLog.details} ->> 'status'` })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, input.companyId),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, input.issueId),
      eq(activityLog.action, "issue.updated"),
      eq(activityLog.runId, input.runId),
      sql`${activityLog.details} ? 'status'`,
    ))
    .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
    .limit(1);
  return row?.status ?? null;
}

/**
 * True when a run recorded a non-active disposition (for example Done or In
 * Review) and the task is active again. The active state then belongs to a
 * later stage opened by someone else, not to that run's missing disposition.
 */
export async function runRecordedDispositionBeforeCurrentStage(
  db: Db,
  input: { companyId: string; issueId: string; runId: string; currentStatus: string },
): Promise<boolean> {
  if (!ACTIVE_ISSUE_STATUSES.has(input.currentStatus)) return false;
  const recorded = await readRunRecordedIssueStatus(db, input);
  return recorded !== null && !ACTIVE_ISSUE_STATUSES.has(recorded);
}

/** True when the issue status changed after `since`, ignoring `excludeRunId`'s own writes. */
export async function issueStatusChangedSince(
  db: Db,
  input: { companyId: string; issueId: string; since: Date; excludeRunId?: string | null },
): Promise<boolean> {
  const [row] = await db
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, input.companyId),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, input.issueId),
      eq(activityLog.action, "issue.updated"),
      gt(activityLog.createdAt, input.since),
      input.excludeRunId
        ? or(isNull(activityLog.runId), ne(activityLog.runId, input.excludeRunId))
        : undefined,
      STATUS_TRANSITION,
    ))
    .limit(1);
  return Boolean(row);
}
