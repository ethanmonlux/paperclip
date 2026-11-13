/**
 * Release pause holds that reached their expiry (FAC-840, STA-361).
 *
 * A pause hold names an owner and an `expiresAt` (12 hours by default), so it
 * cannot park a tree forever. When the expiry passes, the hold is released as
 * the system, with an audit entry and one comment on the root task naming the
 * owner, and its members are woken exactly as an operator release with
 * "wake agents" wakes them: executable, agent-assigned members that no other
 * pause still covers and that have no execution blocker. Work a dispatch gate
 * refused for the hold is re-dispatched once through the shared resume path.
 *
 * The release is a compare-and-set on an active hold whose expiry has passed,
 * so a concurrent manual release or a second sweep never wakes twice.
 */
import { and, eq, inArray } from "drizzle-orm";
import { agents, authUsers, issues, type Db } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import {
  ISSUE_TREE_RESUME_EXECUTABLE_STATUSES,
  PAUSE_HOLD_EXPIRED_RELEASE_REASON,
  issueTreeControlService,
} from "./issue-tree-control.js";
import { resumePauseInterruptedWork } from "./issue-tree-resume.js";

export const ISSUE_TREE_HOLD_EXPIRY_ACTOR_ID = "issue_tree_hold_expiry";

const SYSTEM_ACTOR = { actorType: "system" as const, actorId: ISSUE_TREE_HOLD_EXPIRY_ACTOR_ID };
const MAX_EXPIRED_HOLDS_PER_PASS = 25;

export type IssueTreeHoldExpiryWakeup = (agentId: string, opts: {
  source: "assignment";
  triggerDetail: "system";
  reason: string;
  payload: Record<string, unknown>;
  requestedByActorType: "user" | "agent" | "system";
  requestedByActorId: string;
  idempotencyKey: string;
  contextSnapshot: Record<string, unknown>;
}) => Promise<unknown>;

export function expiredHoldMemberWakeKey(holdId: string, issueId: string) {
  return `tree-hold-expiry:${holdId}:${issueId}`;
}

async function ownerLabel(db: Db, hold: { companyId: string; ownerAgentId?: string | null; ownerUserId?: string | null }) {
  if (hold.ownerAgentId) {
    const [agent] = await db.select({ name: agents.name }).from(agents)
      .where(and(eq(agents.companyId, hold.companyId), eq(agents.id, hold.ownerAgentId)));
    return agent?.name ?? `agent ${hold.ownerAgentId}`;
  }
  if (hold.ownerUserId) {
    const [user] = await db.select({ name: authUsers.name, email: authUsers.email }).from(authUsers)
      .where(eq(authUsers.id, hold.ownerUserId));
    return user?.name || user?.email || `user ${hold.ownerUserId}`;
  }
  return "no recorded owner";
}

/**
 * Expire every due pause hold in scope. Returns the released hold ids, member
 * wake failures, and the next expiry still ahead (for the caller's deadline).
 */
export async function expireDuePauseHolds(db: Db, input: {
  wakeup: IssueTreeHoldExpiryWakeup;
  companyId?: string | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const treeControl = issueTreeControlService(db);
  const { issueService } = await import("./issues.js");
  const issuesSvc = issueService(db);
  const result = {
    expiredHoldIds: [] as string[],
    wokenIssueIds: [] as string[],
    wakeFailures: [] as Array<{ issueId: string; message: string }>,
    nextExpiresAt: null as number | null,
  };

  const due = await treeControl.listExpiredPauseHolds({ now, companyId: input.companyId, limit: MAX_EXPIRED_HOLDS_PER_PASS });
  for (const candidate of due) {
    let hold;
    try {
      hold = await treeControl.releaseHold(candidate.companyId, candidate.rootIssueId, candidate.id, {
        reason: PAUSE_HOLD_EXPIRED_RELEASE_REASON,
        metadata: { expired: true, expiresAt: candidate.expiresAt?.toISOString() ?? null },
        actor: SYSTEM_ACTOR,
        expiredBy: now,
      });
    } catch (error) {
      // Another release (an operator, or a concurrent sweep) won the hold.
      if (error instanceof HttpError && error.status === 409) continue;
      throw error;
    }
    result.expiredHoldIds.push(hold.id);
    const owner = await ownerLabel(db, hold);

    await logActivity(db, {
      companyId: hold.companyId, actorType: "system", actorId: ISSUE_TREE_HOLD_EXPIRY_ACTOR_ID,
      action: "issue.tree_hold_expired", entityType: "issue", entityId: hold.rootIssueId,
      details: {
        holdId: hold.id, mode: hold.mode, reason: hold.reason,
        expiresAt: hold.expiresAt?.toISOString() ?? null,
        ownerAgentId: hold.ownerAgentId ?? null, ownerUserId: hold.ownerUserId ?? null,
        memberCount: hold.members?.length ?? 0,
      },
    });

    // Members a remaining pause, a non-executable status, or an execution
    // blocker keeps out are not woken; current task state governs, as on an
    // operator release.
    const memberIds = [...new Set((hold.members ?? []).map((member) => member.issueId))];
    const candidates = memberIds.length === 0 ? [] : await db.select({
      id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId,
    }).from(issues).where(and(eq(issues.companyId, hold.companyId), inArray(issues.id, memberIds)));
    let woken = 0;
    for (const issue of candidates) {
      if (!issue.assigneeAgentId || issue.assigneeUserId
        || !ISSUE_TREE_RESUME_EXECUTABLE_STATUSES.includes(issue.status)) continue;
      try {
        if (await treeControl.getActivePauseHoldGate(hold.companyId, issue.id)) continue;
        if (await getExecutionBlocker(db, hold.companyId, issue.id)) continue;
        const wake = await input.wakeup(issue.assigneeAgentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_tree_resumed",
          payload: { issueId: issue.id, rootIssueId: hold.rootIssueId, holdId: hold.id, holdExpired: true },
          requestedByActorType: "system",
          requestedByActorId: ISSUE_TREE_HOLD_EXPIRY_ACTOR_ID,
          idempotencyKey: expiredHoldMemberWakeKey(hold.id, issue.id),
          contextSnapshot: {
            issueId: issue.id, taskId: issue.id, wakeReason: "issue_tree_resumed", source: "issue.tree_hold_expiry",
            rootIssueId: hold.rootIssueId, holdId: hold.id,
          },
        });
        if (wake) {
          woken += 1;
          result.wokenIssueIds.push(issue.id);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.wakeFailures.push({ issueId: issue.id, message });
        await Promise.resolve(logActivity(db, {
          companyId: hold.companyId, actorType: "system", actorId: ISSUE_TREE_HOLD_EXPIRY_ACTOR_ID,
          action: "issue.tree_resume_wake_failed", entityType: "issue", entityId: hold.rootIssueId,
          details: { holdId: hold.id, issueId: issue.id, error: message, holdExpired: true },
        })).catch(() => null);
      }
    }

    // Tasks outside the snapshot whose work a gate refused for this hold.
    const currentTree = await treeControl.listTreeIssues(hold.companyId, hold.rootIssueId).catch(() => []);
    result.wakeFailures.push(...await resumePauseInterruptedWork(db, {
      companyId: hold.companyId,
      issueIds: currentTree.map((issue) => issue.id),
      suppressedByHoldId: hold.id,
      excludeIssueIds: memberIds,
      rootIssueId: hold.rootIssueId,
      actor: SYSTEM_ACTOR,
      wakeup: input.wakeup,
    }));

    const expiredAt = hold.expiresAt?.toISOString() ?? now.toISOString();
    await issuesSvc.addComment(hold.rootIssueId, [
      `The pause on this task tree reached its expiry (${expiredAt}) and was released automatically.`,
      "",
      `- Owner: ${owner}`,
      ...(hold.reason ? [`- Pause reason: ${hold.reason}`] : []),
      `- Woken: ${woken} of ${memberIds.length} paused task${memberIds.length === 1 ? "" : "s"}`,
      "",
      "Pause the tree again if the work must stay stopped.",
    ].join("\n"), {}, { authorType: "system" });
  }

  const next = await treeControl.nextPauseHoldExpiry(input.companyId);
  result.nextExpiresAt = next ? next.getTime() : null;
  return result;
}
