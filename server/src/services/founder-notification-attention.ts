import { createHash } from "node:crypto";
import { and, desc, eq, inArray, max, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, issueWorkProducts, issues } from "@paperclipai/db";
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

const HEAD_SHA_METADATA_KEYS = ["sha", "headSha"] as const;

/**
 * The head under review, where the issue's primary work product records one
 * (`metadata.sha`, as work-products.ts reads it). Native execution state has
 * no head field, so an issue without such a work product has no head identity
 * here; see doc/FOUNDER-NOTIFICATIONS.md.
 */
async function primaryHeadShas(db: Db, companyId: string, issueIds: string[]): Promise<Map<string, string>> {
  const rows = await db
    .select({ issueId: issueWorkProducts.issueId, metadata: issueWorkProducts.metadata })
    .from(issueWorkProducts)
    .where(
      and(
        eq(issueWorkProducts.companyId, companyId),
        inArray(issueWorkProducts.issueId, issueIds),
        eq(issueWorkProducts.isPrimary, true),
      ),
    )
    .orderBy(desc(issueWorkProducts.updatedAt));
  const heads = new Map<string, string>();
  for (const row of rows) {
    if (heads.has(row.issueId)) continue;
    const metadata = row.metadata ?? {};
    const sha = HEAD_SHA_METADATA_KEYS.map((key) => readString(metadata[key])).find((value) => value !== null);
    if (sha) heads.set(row.issueId, sha);
  }
  return heads;
}

/**
 * `review:<issue>` names the issue, not one review. Its occurrence is the
 * current gate (stage, last decision, changes-requested round), the recorded
 * head under review where one exists, plus the issue's latest recorded
 * transition into `in_review`. A review that cleared and reopened between
 * polls or while the server was down, or that moved to a new head under the
 * same gate, is a new occurrence; repeated observations of one review stay
 * the same.
 */
async function reviewFingerprints(db: Db, companyId: string, issueIds: string[]): Promise<Map<string, string>> {
  if (issueIds.length === 0) return new Map();
  const [rows, transitions, heads] = await Promise.all([
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
    primaryHeadShas(db, companyId, issueIds),
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
          heads.get(row.id) ?? null,
        ]),
      ];
    }),
  );
}

/**
 * `blocker:<terminal>` names the stalled blocker, not one blocking episode,
 * and the set of issues it holds blocked changes while one stall continues.
 * So it carries no equality fingerprint. Its continuity anchor is the
 * earliest blocking transition among the issues it currently holds blocked:
 * the reconciler continues the open episode while that anchor is no later
 * than the episode's last observation (some hold has lasted since then), and
 * treats it as a new occurrence only when every current hold began after it.
 */
async function blockerContinuityAnchors(
  db: Db,
  companyId: string,
  terminalIds: string[],
): Promise<Map<string, string>> {
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
  return earliest;
}

/**
 * Attaches occurrence identity in the founder adapter only. The shared
 * attention producer and its UI dedup keys are unchanged; the fingerprint is
 * an opaque hash and neither it nor the anchor ever reaches a card.
 */
export async function withFounderOccurrenceFingerprints(
  db: Db,
  companyId: string,
  items: AttentionItem[],
): Promise<FounderAttentionFact[]> {
  const idsFor = (prefix: string) => [
    ...new Set(items.filter((item) => item.dedupKey.startsWith(prefix)).map((item) => item.dedupKey.slice(prefix.length))),
  ];
  const [reviews, anchors] = await Promise.all([
    reviewFingerprints(db, companyId, idsFor(REVIEW_KEY_PREFIX)),
    blockerContinuityAnchors(db, companyId, idsFor(BLOCKER_KEY_PREFIX)),
  ]);
  return items.map((item) => {
    if (item.dedupKey.startsWith(REVIEW_KEY_PREFIX)) {
      const fingerprintFor = reviews.get(item.dedupKey.slice(REVIEW_KEY_PREFIX.length));
      return fingerprintFor ? { ...item, founderOccurrenceFingerprint: fingerprintFor } : item;
    }
    if (item.dedupKey.startsWith(BLOCKER_KEY_PREFIX)) {
      const anchor = anchors.get(item.dedupKey.slice(BLOCKER_KEY_PREFIX.length));
      return anchor ? { ...item, founderContinuityAnchorAt: anchor } : item;
    }
    return item;
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
