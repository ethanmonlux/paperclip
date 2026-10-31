import { createHash } from "node:crypto";
import { and, eq, inArray, max, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, issues } from "@paperclipai/db";
import type { AttentionItem } from "@paperclipai/shared";
import { attentionService } from "./attention.js";
import type { FounderAttentionFact, FounderNotificationSweepDeps } from "./founder-notifications.js";
import { issueService } from "./issues.js";

const REVIEW_KEY_PREFIX = "review:";
const BLOCKER_KEY_PREFIX = "blocker:";

function fingerprint(parts: Array<string | number | null | undefined>): string {
  return createHash("sha256")
    .update(JSON.stringify(parts.map((part) => part ?? null)))
    .digest("hex")
    .slice(0, 24);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * `review:<issue>` names the issue, not one review. Its occurrence is the
 * current gate (stage, last decision, changes-requested round) plus the
 * issue's latest recorded transition into `in_review`, so a review that
 * cleared and reopened between polls, or while the server was down, is a new
 * occurrence while repeated observations of one review stay the same.
 */
async function reviewFingerprints(db: Db, companyId: string, issueIds: string[]): Promise<Map<string, string>> {
  if (issueIds.length === 0) return new Map();
  const [rows, transitions] = await Promise.all([
    db
      .select({ id: issues.id, executionState: issues.executionState })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds))),
    db
      .select({ issueId: activityLog.entityId, at: max(activityLog.createdAt) })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.entityType, "issue"),
          inArray(activityLog.entityId, issueIds),
          eq(activityLog.action, "issue.updated"),
          sql`${activityLog.details}->>'status' = 'in_review'`,
          // Only a recorded change into review; a no-op status echo while
          // already in review must not mint a new occurrence.
          sql`${activityLog.details}->'_previous'->>'status' is not null`,
          sql`${activityLog.details}->'_previous'->>'status' <> 'in_review'`,
        ),
      )
      .groupBy(activityLog.entityId),
  ]);
  const transitionAt = new Map(transitions.map((row) => [row.issueId, row.at ? new Date(row.at).toISOString() : null]));
  return new Map(
    rows.map((row) => {
      const state = (row.executionState ?? {}) as Record<string, unknown>;
      const round = typeof state.changesRequestedCount === "number" ? state.changesRequestedCount : 0;
      return [
        row.id,
        fingerprint([
          "review",
          readString(state.currentStageId),
          readString(state.lastDecisionId),
          round,
          transitionAt.get(row.id) ?? null,
        ]),
      ];
    }),
  );
}

/**
 * `blocker:<terminal>` names the stalled blocker, not one blocking episode.
 * Its occurrence is the earliest blocking transition among the issues it
 * currently holds blocked: a chain that unblocked and re-blocked carries a new
 * transition time. If the earliest dependent alone is released while the
 * blocker stays stalled, this counts as a new occurrence (fail toward telling
 * the founder rather than staying silent).
 */
async function blockerFingerprints(db: Db, companyId: string, terminalIds: string[]): Promise<Map<string, string>> {
  if (terminalIds.length === 0) return new Map();
  const wanted = new Set(terminalIds);
  const blocked = (await issueService(db).list(companyId, { status: "blocked" })) as Array<{
    id: string;
    blockedTransitionAt?: Date | string | null;
    blockerAttention?: { terminalBlockerIssueId?: string | null } | null;
  }>;
  const earliest = new Map<string, string>();
  for (const issue of blocked) {
    const terminal = issue.blockerAttention?.terminalBlockerIssueId ?? issue.id;
    if (!wanted.has(terminal) || !issue.blockedTransitionAt) continue;
    const at = new Date(issue.blockedTransitionAt).toISOString();
    const current = earliest.get(terminal);
    if (!current || at < current) earliest.set(terminal, at);
  }
  return new Map(terminalIds.map((id) => [id, fingerprint(["blocker", earliest.get(id) ?? null])]));
}

/**
 * Attaches occurrence fingerprints in the founder adapter only. The shared
 * attention producer and its UI dedup keys are unchanged; the fingerprint is
 * an opaque hash and never reaches a card.
 */
export async function withFounderOccurrenceFingerprints(
  db: Db,
  companyId: string,
  items: AttentionItem[],
): Promise<FounderAttentionFact[]> {
  const idsFor = (prefix: string) => [
    ...new Set(items.filter((item) => item.dedupKey.startsWith(prefix)).map((item) => item.dedupKey.slice(prefix.length))),
  ];
  const [reviews, blockers] = await Promise.all([
    reviewFingerprints(db, companyId, idsFor(REVIEW_KEY_PREFIX)),
    blockerFingerprints(db, companyId, idsFor(BLOCKER_KEY_PREFIX)),
  ]);
  return items.map((item) => {
    const fingerprintFor = item.dedupKey.startsWith(REVIEW_KEY_PREFIX)
      ? reviews.get(item.dedupKey.slice(REVIEW_KEY_PREFIX.length))
      : item.dedupKey.startsWith(BLOCKER_KEY_PREFIX)
        ? blockers.get(item.dedupKey.slice(BLOCKER_KEY_PREFIX.length))
        : undefined;
    return fingerprintFor ? { ...item, founderOccurrenceFingerprint: fingerprintFor } : item;
  });
}

/**
 * The recipient's complete desk: their own dismissals, their read boundary,
 * and every page at once, so absence from the snapshot reliably means the
 * fact cleared. A feed or fingerprint failure throws and therefore resolves
 * nothing.
 */
export function founderNotificationAttentionSource(db: Db): FounderNotificationSweepDeps["listAttention"] {
  const attention = attentionService(db);
  return async (companyId, recipientUserId, actor) => {
    const { items } = await attention.list(companyId, {
      userId: recipientUserId,
      actor,
      includeDismissed: true,
      all: true,
      allowUnscopedAll: true,
    });
    return withFounderOccurrenceFingerprints(db, companyId, items);
  };
}
