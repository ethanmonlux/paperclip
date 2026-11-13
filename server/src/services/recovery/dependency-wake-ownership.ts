/**
 * Whether a blocked task's blocker relations still own a wake (FAC-840 wait
 * contract, FAC-851).
 *
 * A blocker relation is a wait record only while the dependency path can still
 * wake the assignee: a blocker is unresolved or awaiting workspace finalize, or
 * the resolved-dependency backstop will (or did not yet) deliver its wake. When
 * every blocker is done and that wake is spent, or the assignee opened this
 * blocked cycle itself after the blockers were done (the backstop skips that
 * case so a self-block cannot loop), the relations wait for nothing. The task
 * then belongs to the orphan-wait path like any other blocked task with no wait
 * record. The backstop, the orphan sweep and the blocked inbox all read this.
 */
import { and, desc, eq, gt, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { activityLog, heartbeatRuns, issues, workspaceOperations, type Db } from "@paperclipai/db";
import { findExistingIssueBlockersResolvedWakeForReadyState } from "../issue-dependency-wakeups.js";

type ReadDb = Pick<Db, "select">;

export interface DependencyWakeReadiness {
  isDependencyReady: boolean;
  blockerIssueIds: string[];
}

export interface DependencyWakeCandidate {
  id: string;
  assigneeAgentId: string | null;
  blockedTransitionAt: Date | null;
}

/**
 * True when the assignee agent opened the current blocked cycle and no blocker
 * completed or finalized after it: the agent knew the blockers were resolved,
 * so it waits on something outside the blocker graph.
 */
export async function wasBlockedByAssigneeAgent(
  db: ReadDb,
  companyId: string,
  issueId: string,
  agentId: string,
  blockedTransitionAt: Date | null,
  blockerIssueIds: string[],
) {
  if (!blockedTransitionAt) return false;
  const row = await db
    .select({
      actorType: activityLog.actorType,
      actorId: activityLog.actorId,
      agentId: activityLog.agentId,
      runAgentId: heartbeatRuns.agentId,
      details: activityLog.details,
    })
    .from(activityLog)
    .leftJoin(heartbeatRuns, and(
      eq(heartbeatRuns.id, activityLog.runId),
      eq(heartbeatRuns.companyId, companyId),
      or(eq(heartbeatRuns.issueId, issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`),
    ))
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, issueId),
        eq(activityLog.action, "issue.updated"),
        gte(activityLog.createdAt, new Date(blockedTransitionAt.getTime() - 5_000)),
        sql`(
          ${activityLog.details} ?| array['status', 'toStatus', 'assigneeAgentId', 'assigneeUserId', 'blockedByIssueIds']
          or (${activityLog.details}->'changes') ?| array['status', 'assigneeAgentId', 'assigneeUserId', 'blockedByIssueIds']
        )`,
      ),
    )
    .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const details = row?.details ?? {};
  const selfBlocked = row?.actorType === "agent" && row.agentId === agentId && details.status === "blocked";
  const nativeSelfBlocked = row?.actorType === "system" &&
    row.actorId === "native-status-committer" && row.runAgentId === agentId &&
    details.source === "native_status_decision" && details.toStatus === "blocked" &&
    details.reasonCode !== "durable_dependency_blocker_bound";
  if (!selfBlocked && !nativeSelfBlocked) return false;
  const newlyCompletedBlocker = await db.select({ id: issues.id }).from(issues).where(and(
    eq(issues.companyId, companyId),
    inArray(issues.id, blockerIssueIds),
    gt(issues.completedAt, blockedTransitionAt),
  )).limit(1);
  if (newlyCompletedBlocker.length > 0) return false;
  const newlyFinalizedBlocker = await db.select({ id: workspaceOperations.id }).from(workspaceOperations)
    .innerJoin(issues, and(eq(issues.companyId, companyId), inArray(issues.id, blockerIssueIds),
      eq(workspaceOperations.issueId, issues.id),
      or(eq(issues.executionWorkspaceId, workspaceOperations.executionWorkspaceId),
        and(isNull(workspaceOperations.executionWorkspaceId),
          sql`${workspaceOperations.metadata}->>'owningService' = 'workspace_recovery'`))))
    .where(and(eq(workspaceOperations.companyId, companyId), eq(workspaceOperations.phase, "workspace_finalize"),
      eq(workspaceOperations.status, "succeeded"), gt(workspaceOperations.finishedAt, blockedTransitionAt)))
    .limit(1);
  return newlyFinalizedBlocker.length === 0;
}

/**
 * True when the task has blocker relations but none of them can wake it: all
 * blockers are done and finalized, and the dependency wake for this blocked
 * cycle was already delivered or is withheld because the assignee self-blocked.
 * An unresolved or finalizing blocker, or an in-flight dependency wake, still
 * owns the wait.
 */
export async function dependencyWakeDisowned(
  db: ReadDb,
  companyId: string,
  candidate: DependencyWakeCandidate,
  readiness: DependencyWakeReadiness | null | undefined,
) {
  if (!candidate.assigneeAgentId || !readiness?.isDependencyReady || readiness.blockerIssueIds.length === 0) return false;
  const existingWake = await findExistingIssueBlockersResolvedWakeForReadyState(db, {
    companyId,
    dependentIssueId: candidate.id,
    blockerIssueIds: readiness.blockerIssueIds,
    blockedTransitionAt: candidate.blockedTransitionAt,
  });
  if (existingWake) return existingWake.status === "completed";
  return wasBlockedByAssigneeAgent(db, companyId, candidate.id, candidate.assigneeAgentId,
    candidate.blockedTransitionAt, readiness.blockerIssueIds);
}
