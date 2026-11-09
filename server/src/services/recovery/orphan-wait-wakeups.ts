/**
 * Wake the owner of a blocked task that has no wait record (`issue_wait_orphaned`).
 *
 * FAC-840 wait contract: a task that is not running must say what it waits
 * for. Blocked tasks do that through an unresolved blocker, a pending
 * interaction or approval, an unblock action owned by someone else, a recorded
 * external owner, a scheduled monitor, or an open recovery issue. A blocked
 * task with none of these and no live run or queued wake can wait forever:
 * STA-144 set its own task blocked with nothing to wake it.
 *
 * Each orphaned blocked cycle wakes the assignee once (the key names the
 * cycle), and at most MAX_ORPHAN_WAKES_PER_DAY times a day per task, so an
 * owner that re-blocks without recording a wait cannot loop. After the cap the
 * task stays visible as `blocked_without_wait_path` in the blocked inbox and
 * Staple Console instead of being woken again.
 *
 * The scoped recovery worker drops an issue it has checked unless the check
 * names a deadline, so a task still inside its grace period, or whose wake was
 * refused, reports when to look again (`retryAt`), and a wake that failed to
 * enqueue is counted in `failed` for the worker's retry.
 */
import { and, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { agentWakeupRequests, companies, issues, type Db } from "@paperclipai/db";
import { ISSUE_WAIT_ORPHANED_WAKE_REASON } from "@paperclipai/shared";
import { logActivity } from "../activity-log.js";
import { visibleIssueCondition } from "../issue-visibility.js";
import { RECOVERY_ORIGIN_KINDS } from "./origins.js";
import { hasRecordedExternalOwner } from "./issue-graph-liveness.js";

/** A run that just set Blocked may still be recording its wait. */
export const ORPHAN_WAIT_GRACE_MS = 5 * 60_000;
export const MAX_ORPHAN_WAKES_PER_DAY = 3;
/** A refused wake (agent paused, wakes disabled) is offered again after this. */
export const ORPHAN_REFUSED_WAKE_RETRY_MS = 10 * 60_000;
const MAX_ORPHANS_PER_PASS = 100;
const DAY_MS = 24 * 60 * 60_000;
const SKIPPED_WAKE_STATUSES = ["skipped", "failed", "cancelled"];

export const ORPHAN_WAIT_INSTRUCTION =
  "This task is blocked, but nothing records what it waits for, so nothing will wake it. " +
  "Record a wait: add the blocking task as a blocker, ask through an interaction, set an unblock action owned by someone else, " +
  "or return the task to in progress with a monitor (kind ci or pr_mergeable for GitHub waits). If nothing blocks it, resume the work.";

export type OrphanWaitWakeup = (agentId: string, input: {
  source: "automation";
  triggerDetail: "system";
  reason: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  requestedByActorType: "system";
  requestedByActorId: string;
  contextSnapshot: Record<string, unknown>;
  issueStateGuard: { statuses: string[]; assigneeAgentId: string };
}) => Promise<unknown>;

export function orphanWaitWakeKey(issueId: string, blockedTransitionAt: Date | null) {
  return [ISSUE_WAIT_ORPHANED_WAKE_REASON, issueId, blockedTransitionAt?.toISOString() ?? "unknown"].join(":");
}

/** Blocked, agent-owned tasks with no wait record in the database. Live paths are checked by the caller. */
async function readOrphanCandidates(db: Db, opts: { companyId?: string | null; issueId?: string | null; now: Date }) {
  const recoveryOriginKinds = Object.values(RECOVERY_ORIGIN_KINDS);
  return db.select({
    id: issues.id,
    companyId: issues.companyId,
    identifier: issues.identifier,
    title: issues.title,
    description: issues.description,
    assigneeAgentId: issues.assigneeAgentId,
    blockedTransitionAt: issues.blockedTransitionAt,
  }).from(issues)
    .innerJoin(companies, eq(companies.id, issues.companyId))
    .where(and(
      eq(companies.status, "active"),
      eq(issues.status, "blocked"),
      visibleIssueCondition(),
      isNull(issues.conversationAgentId),
      isNull(issues.assigneeUserId),
      sql`${issues.assigneeAgentId} is not null`,
      opts.companyId ? eq(issues.companyId, opts.companyId) : undefined,
      opts.issueId ? eq(issues.id, opts.issueId) : undefined,
      or(isNull(issues.monitorNextCheckAt), lte(issues.monitorNextCheckAt, opts.now)),
      // An unblock action owned by someone other than the assignee is a wait record.
      or(isNull(issues.unblockDescriptor),
        sql`${issues.unblockDescriptor}->'owner'->>'agentId' = ${issues.assigneeAgentId}::text`),
      sql`not exists (select 1 from issue_relations relation
        join issues blocker on blocker.id = relation.issue_id and blocker.company_id = relation.company_id
        where relation.company_id = ${issues.companyId} and relation.type = 'blocks'
          and relation.related_issue_id = ${issues.id} and blocker.status <> 'done')`,
      sql`not exists (select 1 from issue_thread_interactions interaction
        where interaction.company_id = ${issues.companyId} and interaction.issue_id = ${issues.id}
          and interaction.status = 'pending')`,
      sql`not exists (select 1 from issue_approvals link
        join approvals approval on approval.id = link.approval_id
        where link.company_id = ${issues.companyId} and link.issue_id = ${issues.id}
          and approval.status in ('pending', 'revision_requested'))`,
      sql`not exists (select 1 from issues recovery
        where recovery.company_id = ${issues.companyId} and recovery.origin_id = ${issues.id}::text
          and recovery.origin_kind in (${sql.join(recoveryOriginKinds.map(kind => sql`${kind}`), sql`, `)})
          and recovery.status not in ('done', 'cancelled'))`,
    ))
    .orderBy(issues.id)
    .limit(MAX_ORPHANS_PER_PASS);
}

export async function wakeOwnersOfOrphanedWaits(db: Db, enqueueWakeup: OrphanWaitWakeup, opts: {
  companyId?: string | null;
  issueId?: string | null;
  now?: Date;
  /** True when the task has an active run, queued wake, or pause hold. */
  hasLivePath: (companyId: string, issueId: string, agentId: string) => Promise<boolean>;
}) {
  const now = opts.now ?? new Date();
  const result = { orphans: 0, woken: 0, alreadyWoken: 0, capped: 0, livePathSkipped: 0, inGrace: 0, deferred: 0, failed: 0,
    retryAt: null as number | null, issueIds: [] as string[] };
  const retryAt = (at: number) => { result.retryAt = result.retryAt === null ? at : Math.min(result.retryAt, at); };
  const candidates = await readOrphanCandidates(db, { companyId: opts.companyId, issueId: opts.issueId, now });
  for (const candidate of candidates) {
    const agentId = candidate.assigneeAgentId!;
    if (hasRecordedExternalOwner(candidate.description)) continue;
    const graceEndsAt = candidate.blockedTransitionAt
      ? candidate.blockedTransitionAt.getTime() + ORPHAN_WAIT_GRACE_MS : null;
    if (graceEndsAt !== null && graceEndsAt > now.getTime()) {
      result.inGrace += 1;
      retryAt(graceEndsAt);
      continue;
    }
    if (await opts.hasLivePath(candidate.companyId, candidate.id, agentId)) {
      result.livePathSkipped += 1;
      continue;
    }
    result.orphans += 1;
    const idempotencyKey = orphanWaitWakeKey(candidate.id, candidate.blockedTransitionAt);
    const priorWakes = await db.select({ key: agentWakeupRequests.idempotencyKey }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, candidate.companyId),
      eq(agentWakeupRequests.reason, ISSUE_WAIT_ORPHANED_WAKE_REASON),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${candidate.id}`,
      sql`${agentWakeupRequests.status} not in (${sql.join(SKIPPED_WAKE_STATUSES.map(status => sql`${status}`), sql`, `)})`,
      gte(agentWakeupRequests.createdAt, new Date(now.getTime() - DAY_MS)),
    ));
    if (priorWakes.some(wake => wake.key === idempotencyKey)) {
      result.alreadyWoken += 1;
      continue;
    }
    if (priorWakes.length >= MAX_ORPHAN_WAKES_PER_DAY) {
      result.capped += 1;
      continue;
    }
    try {
      const wake = await enqueueWakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: ISSUE_WAIT_ORPHANED_WAKE_REASON,
        payload: { issueId: candidate.id, waitContract: "orphaned", instruction: ORPHAN_WAIT_INSTRUCTION },
        idempotencyKey,
        requestedByActorType: "system",
        requestedByActorId: "wait_contract",
        contextSnapshot: {
          issueId: candidate.id, taskId: candidate.id, wakeReason: ISSUE_WAIT_ORPHANED_WAKE_REASON,
          source: "issue.wait_contract.orphan", instruction: ORPHAN_WAIT_INSTRUCTION,
        },
        issueStateGuard: { statuses: ["blocked"], assigneeAgentId: agentId },
      });
      // Null is a refusal (wakes disabled, agent paused): no wake row exists,
      // so offer it again later rather than dropping the obligation.
      if (!wake) {
        result.deferred += 1;
        retryAt(now.getTime() + ORPHAN_REFUSED_WAKE_RETRY_MS);
        continue;
      }
    } catch {
      result.failed += 1;
      continue;
    }
    result.woken += 1;
    result.issueIds.push(candidate.id);
    await logActivity(db, {
      companyId: candidate.companyId, actorType: "system", actorId: "wait_contract", agentId,
      action: "issue.wait_orphan_woken", entityType: "issue", entityId: candidate.id,
      details: { identifier: candidate.identifier, idempotencyKey,
        blockedTransitionAt: candidate.blockedTransitionAt?.toISOString() ?? null, wakesToday: priorWakes.length + 1 },
    }).catch(() => undefined);
  }
  return result;
}
