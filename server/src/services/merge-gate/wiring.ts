/** Database and GitHub wiring for the protected-main merge gate (FAC-840 B). */
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, ne, notInArray, or, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueDocuments,
  issueRelations,
  issueThreadInteractions,
  issues,
  withDedicatedDbConnection,
  type Db,
} from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../activity-log.js";
import { resolveGitHubApiCredential } from "../git-credentials.js";
import { resolveGitHubOperationCredentials } from "../github-operation-credentials.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "../issue-assignment-wakeup.js";
import { issueService } from "../issues.js";
import { withWorkspaceLockKeepalive } from "../native-runtime/native-workspace-lock-keepalive.js";
import { createMergeGateGitHub } from "./github.js";
import {
  modelFamiliesFromRunUsage,
  parseMergeReviewDocument,
  parseVisualReviewDocument,
  type MergeReviewAttestation,
  type VisualReviewAttestation,
} from "./policy.js";
import {
  evaluateAndMerge,
  MERGE_GATE_RED_MAIN_ORIGIN_KIND,
  MERGE_LOCK_BUSY,
  MERGE_REVIEW_DOCUMENT_KEY,
  reportRedMain,
  VISUAL_REVIEW_DOCUMENT_KEY,
  type MergeGateDependencies,
  type MergeGateRequest,
} from "./service.js";

const TERMINAL_ISSUE_STATUSES = ["done", "cancelled"];

const gateIssueColumns = {
  id: issues.id,
  companyId: issues.companyId,
  identifier: issues.identifier,
  title: issues.title,
  status: issues.status,
  priority: issues.priority,
  projectId: issues.projectId,
  parentId: issues.parentId,
  assigneeAgentId: issues.assigneeAgentId,
  createdByAgentId: issues.createdByAgentId,
  originKind: issues.originKind,
  originId: issues.originId,
};

/** Agents marked urgent-capable (`runtimeConfig.heartbeat.urgentLane: true`), least busy first. */
async function pickUrgentCapableAgent(db: Db, companyId: string): Promise<string | null> {
  const rows = await db
    .select({ id: agents.id, running: sql<number>`(
      select count(*) from ${heartbeatRuns}
      where ${heartbeatRuns.agentId} = ${agents.id} and ${heartbeatRuns.status} = 'running'
    )` })
    .from(agents)
    .where(and(
      eq(agents.companyId, companyId),
      notInArray(agents.status, ["paused", "terminated", "pending_approval", "error"]),
      sql`coalesce((${agents.runtimeConfig} -> 'heartbeat' ->> 'urgentLane')::boolean, false)`,
    ));
  rows.sort((left, right) => Number(left.running) - Number(right.running));
  return rows[0]?.id ?? null;
}

const MAX_AUTHOR_RUNS = 500;
const MAX_ASSIGNMENT_EVENTS = 500;

function assignmentChange(details: Record<string, unknown> | null): { from: string | null; to: string | null } | null {
  const change = (details?.changes as Record<string, unknown> | undefined)?.assigneeAgentId;
  if (!change || typeof change !== "object") return null;
  const fields = change as Record<string, unknown>;
  return {
    from: typeof fields.from === "string" ? fields.from : null,
    to: typeof fields.to === "string" ? fields.to : null,
  };
}

/** Hold a transaction-scoped advisory lock on its own connection for `action`. */
async function withAdvisoryTryLock<T>(db: Db, key: string, action: () => Promise<T>): Promise<T | typeof MERGE_LOCK_BUSY> {
  const locked = (lockDb: Db) => lockDb.transaction(async tx => {
    const rows = await tx.execute<{ acquired: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as acquired`);
    if (!rows[0]?.acquired) return MERGE_LOCK_BUSY;
    // GitHub reads can outlast idle_in_transaction_session_timeout; losing the session would release the lock.
    const settings = await tx.execute<{ idle_timeout_ms: string }>(
      sql`select setting::bigint as idle_timeout_ms from pg_settings where name = 'idle_in_transaction_session_timeout'`,
    );
    return withWorkspaceLockKeepalive(tx, Number(settings[0]?.idle_timeout_ms), action);
  });
  try {
    // A dedicated connection, so the held lock never starves the pool the action uses.
    return await withDedicatedDbConnection(db, locked);
  } catch (err) {
    if (err instanceof Error && err.message === "dedicated_connection_requires_create_db") return locked(db);
    throw err;
  }
}

/**
 * Review documents with `key` on the given review issues (or, when none are
 * given, naming the pull request), oldest first. The latest revision is the
 * record: its text, its author, and the run that wrote it.
 */
async function latestReviewDocuments<T>(
  db: Db, companyId: string, key: string,
  input: { reviewIssueIds: string[]; repo: string; pullNumber: number },
  parse: (body: string) => T | null,
) {
  const reference = `${input.repo}#${input.pullNumber}`;
  const rows = await db
    .select({
      issueId: issues.id,
      identifier: issues.identifier,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      documentId: documents.id,
      updatedAt: documents.updatedAt,
    })
    .from(issueDocuments)
    .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
    .innerJoin(issues, eq(issues.id, issueDocuments.issueId))
    .where(and(
      eq(issueDocuments.companyId, companyId),
      eq(issueDocuments.key, key),
      input.reviewIssueIds.length > 0
        ? inArray(issueDocuments.issueId, input.reviewIssueIds)
        : sql`${documents.latestBody} ilike ${`%${reference}%`}`,
    ))
    .orderBy(documents.updatedAt)
    .limit(20);
  const found: Array<{
    row: (typeof rows)[number]; revision: { body: string; agentId: string | null; runId: string | null; createdAt: Date }; parsed: T;
  }> = [];
  for (const row of rows) {
    const [revision] = await db.select({
      body: documentRevisions.body,
      agentId: documentRevisions.createdByAgentId,
      runId: documentRevisions.createdByRunId,
      createdAt: documentRevisions.createdAt,
    }).from(documentRevisions)
      .where(and(eq(documentRevisions.companyId, companyId), eq(documentRevisions.documentId, row.documentId)))
      .orderBy(desc(documentRevisions.revisionNumber))
      .limit(1);
    const parsed = revision ? parse(revision.body) : null;
    if (revision && parsed) found.push({ row, revision, parsed });
  }
  return found;
}

export function createMergeGateDependencies(db: Db, options: { heartbeat?: IssueAssignmentWakeupDeps } = {}): MergeGateDependencies {
  const issuesSvc = issueService(db);
  const loadIssue = async (companyId: string, issueId: string) => {
    const [row] = await db.select(gateIssueColumns).from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
    return row ?? null;
  };
  return {
    github: (repo, token) => createMergeGateGitHub({ repo, token }),
    async resolveToken(companyId, actor) {
      if (actor.type === "agent") {
        if (!actor.agentId || !actor.runId) return null;
        const resolved = await resolveGitHubOperationCredentials(db, { companyId, agentId: actor.agentId, runId: actor.runId });
        return resolved.env.GH_TOKEN ?? null;
      }
      return (await resolveGitHubApiCredential(db, companyId))?.token ?? null;
    },
    loadIssue,
    async loadLegacyDelegation(companyId, issueId, coordinatorAgentId) {
      // Legacy tasks were sometimes created for a coordinator by a human,
      // then reassigned to an engineer and returned after implementation.
      // A current assignee alone is not evidence of coordinator authority.
      const events = await db.select({ action: activityLog.action, actorType: activityLog.actorType,
        actorId: activityLog.actorId, details: activityLog.details, createdAt: activityLog.createdAt })
        .from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, issueId), inArray(activityLog.action, ["issue.created", "issue.updated"])))
        .orderBy(asc(activityLog.createdAt)).limit(MAX_ASSIGNMENT_EVENTS + 1);
      if (events.length > MAX_ASSIGNMENT_EVENTS) return false;
      const created = events.find(event => event.action === "issue.created");
      if (created?.details?.assigneeAgentId !== coordinatorAgentId) return false;
      const transfers = events.filter(event => event.action === "issue.updated")
        .map(event => ({ ...event, change: assignmentChange(event.details) }))
        .filter(event => event.change !== null);
      const returned = transfers.at(-1);
      const implementerAgentId = returned?.change?.from;
      if (!returned || !implementerAgentId || implementerAgentId === coordinatorAgentId ||
        returned.change?.to !== coordinatorAgentId || returned.actorType !== "agent" ||
        returned.actorId !== implementerAgentId) return false;
      const delegated = transfers.find(event => event.change?.from === coordinatorAgentId &&
        event.change.to === implementerAgentId && event.actorType === "agent" &&
        event.actorId === coordinatorAgentId && event.createdAt < returned.createdAt);
      if (!delegated) return false;
      const [run] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.issueId, issueId),
          eq(heartbeatRuns.agentId, implementerAgentId), isNotNull(heartbeatRuns.startedAt),
          gte(heartbeatRuns.startedAt, delegated.createdAt),
          lte(heartbeatRuns.startedAt, returned.createdAt))).limit(1);
      return Boolean(run);
    },
    async loadAcceptedCoordinatorRouting(companyId, issueId, implementerAgentId, coordinatorAgentId) {
      // STA-315: an engineer-created task can retain its engineer assignee while
      // a separate coordinator accepts the addressed review-routing handoff.
      // Bind the record to this issue and both actors; ordinary confirmations
      // cannot grant merge authority.
      const rows = await db.select({ idempotencyKey: issueThreadInteractions.idempotencyKey,
        title: issueThreadInteractions.title, payload: issueThreadInteractions.payload })
        .from(issueThreadInteractions)
        .where(and(eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.issueId, issueId),
          eq(issueThreadInteractions.kind, "request_confirmation"), eq(issueThreadInteractions.status, "accepted"),
          eq(issueThreadInteractions.createdByAgentId, implementerAgentId),
          eq(issueThreadInteractions.addresseeAgentId, coordinatorAgentId),
          eq(issueThreadInteractions.resolvedByAgentId, coordinatorAgentId)))
        .orderBy(desc(issueThreadInteractions.createdAt)).limit(20);
      return rows.some(row => row.idempotencyKey?.startsWith(`confirmation:${issueId}:route-review:`) &&
        row.title?.startsWith("Route cross-model review:") &&
        "target" in row.payload && row.payload.target?.type === "issue_document" &&
        row.payload.target.issueId === issueId);
    },
    async loadTaskCustodians(companyId, issueId) {
      // Only an assignee can check a task out, and every reassignment is
      // logged with both sides, so the creator, the current assignee and these
      // events name every agent that could have executed it.
      const [issue] = await db.select({ createdByAgentId: issues.createdByAgentId, assigneeAgentId: issues.assigneeAgentId })
        .from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId))).limit(1);
      if (!issue) return null;
      const events = await db.select({ action: activityLog.action, agentId: activityLog.agentId, details: activityLog.details })
        .from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, issueId), or(
            inArray(activityLog.action, ["issue.created", "issue.child_created", "issue.checked_out"]),
            and(eq(activityLog.action, "issue.updated"),
              sql`${activityLog.details} -> 'changes' -> 'assigneeAgentId' is not null`),
          )))
        .limit(MAX_ASSIGNMENT_EVENTS + 1);
      if (events.length > MAX_ASSIGNMENT_EVENTS) return null;
      const custodians = new Set<string>();
      const add = (value: unknown) => { if (typeof value === "string" && value) custodians.add(value); };
      add(issue.createdByAgentId);
      add(issue.assigneeAgentId);
      for (const event of events) {
        add(event.details?.assigneeAgentId);
        if (event.action === "issue.checked_out") {
          add(event.agentId);
          add(event.details?.agentId);
        }
        const change = assignmentChange(event.details);
        add(change?.from);
        add(change?.to);
      }
      return [...custodians].sort();
    },
    async loadTaskAuthorship(companyId, input) {
      // Without a reviewer-attested source author set, every task run remains
      // a potential author. An attested set must be backed by started runs,
      // and never narrows away the attesting reviewer's own runs: nothing
      // recorded shows a run on the task wrote no source.
      const sourceIds = input.sourceAuthorAgentIds;
      if (sourceIds && (sourceIds.length === 0 || sourceIds.length > MAX_AUTHOR_RUNS)) return null;
      const countedIds = sourceIds && input.attesterAgentId ? [...new Set([...sourceIds, input.attesterAgentId])] : sourceIds;
      const runs = await db.select({ agentId: heartbeatRuns.agentId, usage: heartbeatRuns.usageJson })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.issueId, input.issueId),
          isNotNull(heartbeatRuns.startedAt),
          countedIds ? inArray(heartbeatRuns.agentId, countedIds) : undefined,
          input.excludeAgentId ? ne(heartbeatRuns.agentId, input.excludeAgentId) : undefined,
        ))
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(MAX_AUTHOR_RUNS + 1);
      if (runs.length > MAX_AUTHOR_RUNS) return null;
      const byAgent = new Map<string, { families: Set<string>; unrecorded: number }>();
      for (const run of runs) {
        const entry = byAgent.get(run.agentId) ?? { families: new Set<string>(), unrecorded: 0 };
        const families = modelFamiliesFromRunUsage(run.usage);
        if (families.length === 0) entry.unrecorded += 1;
        for (const family of families) entry.families.add(family);
        byAgent.set(run.agentId, entry);
      }
      if (sourceIds && sourceIds.some(id => !byAgent.has(id))) return null;
      // A run that recorded no model (killed early, say) is attributed to its
      // agent's recorded families on this task; an agent with none is unknown.
      const families = new Set<string>();
      for (const entry of byAgent.values()) {
        if (entry.families.size === 0 && entry.unrecorded > 0) return null;
        for (const family of entry.families) families.add(family);
      }
      return { agentIds: [...byAgent.keys()].sort(), modelFamilies: [...families].sort() };
    },
    withMergeLock: (key, action) => withAdvisoryTryLock(db, key, action),
    async loadReviews(companyId, input) {
      const attestations: MergeReviewAttestation[] = [];
      for (const { row, revision, parsed } of await latestReviewDocuments(db, companyId, MERGE_REVIEW_DOCUMENT_KEY, input, parseMergeReviewDocument)) {
        const [run] = revision.runId
          ? await db.select({ agentId: heartbeatRuns.agentId, usage: heartbeatRuns.usageJson }).from(heartbeatRuns)
            .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, revision.runId)))
          : [];
        attestations.push({
          ...parsed,
          reviewIssueId: row.issueId,
          reviewIssueIdentifier: row.identifier,
          reviewIssueStatus: row.status,
          reviewerAgentId: revision.agentId,
          reviewerModelFamilies: run && run.agentId === revision.agentId ? modelFamiliesFromRunUsage(run.usage) : [],
          writtenByReviewer: Boolean(revision.agentId) && revision.agentId === row.assigneeAgentId,
          recordedAt: revision.createdAt.toISOString(),
        });
      }
      return attestations;
    },
    async loadVisualReviews(companyId, input) {
      const attestations: VisualReviewAttestation[] = [];
      for (const { row, revision, parsed } of await latestReviewDocuments(db, companyId, VISUAL_REVIEW_DOCUMENT_KEY, input, parseVisualReviewDocument)) {
        // The writer's own run, and the designation on its agent record: an
        // operator marks the visual reviewer `runtimeConfig.mergeGate.visualReviewer: true`.
        const [run] = revision.runId
          ? await db.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns)
            .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, revision.runId)))
          : [];
        const [writer] = revision.agentId
          ? await db.select({
            status: agents.status,
            designated: sql<boolean>`coalesce(${agents.runtimeConfig} -> 'mergeGate' -> 'visualReviewer' = 'true'::jsonb, false)`,
          }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, revision.agentId)))
          : [];
        attestations.push({
          ...parsed,
          reviewIssueId: row.issueId,
          reviewIssueIdentifier: row.identifier,
          reviewIssueStatus: row.status,
          reviewerAgentId: revision.agentId,
          writtenByReviewer: Boolean(revision.agentId) && revision.agentId === row.assigneeAgentId && run?.agentId === revision.agentId,
          designatedReviewer: Boolean(writer?.designated) && writer?.status !== "terminated",
          recordedAt: revision.createdAt.toISOString(),
        });
      }
      return attestations;
    },
    async ensureRedMainIssue(input) {
      const originId = `${input.repo.toLowerCase()}:${input.baseRef}`;
      const owner = await db.transaction(async tx => {
        // One owner per repository branch, even when two merges race.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${input.companyId}:${MERGE_GATE_RED_MAIN_ORIGIN_KIND}:${originId}`}))`);
        const [existing] = await tx.select(gateIssueColumns).from(issues).where(and(
          eq(issues.companyId, input.companyId),
          eq(issues.originKind, MERGE_GATE_RED_MAIN_ORIGIN_KIND),
          eq(issues.originId, originId),
          notInArray(issues.status, TERMINAL_ISSUE_STATUSES),
        )).orderBy(desc(issues.createdAt)).limit(1);
        if (existing) return { issue: existing, created: false };
        if (!input.createIfMissing) return null;
        const assigneeAgentId = (await pickUrgentCapableAgent(db, input.companyId)) ?? input.fallbackAssigneeAgentId;
        const evidence = input.failing.length > 0
          ? `CI on \`${input.baseRef}\` head \`${input.baseSha}\` failed: ${input.failing.join(", ")}.`
          : input.evidence ?? "Reported red by an agent.";
        const created = await issuesSvc.create(input.companyId, {
          title: `Red main: fix ${input.repo} ${input.baseRef}`,
          description: [
            `\`${input.repo}\` \`${input.baseRef}\` is red, so the merge gate has stopped merges into it (FAC-840 B).`,
            "",
            `Evidence: ${evidence}`,
            "",
            "This issue is the single owner of the fix. Other agents do not chase it: their merges are parked on this issue and resume when it is done.",
            "Open the fix as a task under this issue (or on this issue itself) so the gate lets it merge, then mark this issue done once the base is green.",
          ].join("\n"),
          status: "todo",
          priority: "critical",
          projectId: input.projectId,
          assigneeAgentId,
          originKind: MERGE_GATE_RED_MAIN_ORIGIN_KIND,
          originId,
          createdByAgentId: input.actor.type === "agent" ? input.actor.agentId ?? null : null,
          createdByUserId: input.actor.type === "board" ? input.actor.userId ?? null : null,
        } as Parameters<typeof issuesSvc.create>[1], tx);
        const [row] = await tx.select(gateIssueColumns).from(issues).where(eq(issues.id, created.id));
        return { issue: row!, created: true };
      });
      // After commit, through the native assignment path, so the urgent-capable
      // assignee gets a queued repair run now rather than on a later heartbeat.
      if (owner?.created && options.heartbeat) {
        try {
          await queueIssueAssignmentWakeup({
            heartbeat: options.heartbeat,
            issue: owner.issue,
            reason: "issue_assigned",
            mutation: "create",
            contextSource: "merge_gate.red_main",
            requestedByActorType: input.actor.type === "agent" ? "agent" : "user",
            requestedByActorId: (input.actor.type === "agent" ? input.actor.agentId : input.actor.userId) ?? null,
            rethrowOnError: true,
          });
        } catch (err) {
          logger.warn({ err, issueId: owner.issue.id }, "merge gate could not queue the red-main owner's assignment wake");
        }
      }
      return owner;
    },
    async parkOnIssue(input) {
      const existing = await db.select({ blockerId: issueRelations.issueId }).from(issueRelations).where(and(
        eq(issueRelations.companyId, input.companyId),
        eq(issueRelations.relatedIssueId, input.issueId),
        eq(issueRelations.type, "blocks"),
      ));
      const blockers = existing.map(row => row.blockerId);
      if (blockers.includes(input.blockerIssueId)) return;
      await issuesSvc.update(input.issueId, {
        blockedByIssueIds: [...blockers, input.blockerIssueId],
        actorAgentId: input.actor.type === "agent" ? input.actor.agentId ?? null : null,
        actorRunId: input.actor.runId ?? null,
        actorUserId: input.actor.type === "board" ? input.actor.userId ?? null : null,
      });
    },
    async log(input) {
      await logActivity(db, {
        companyId: input.companyId,
        actorType: input.actor.type === "agent" ? "agent" : "user",
        actorId: (input.actor.type === "agent" ? input.actor.agentId : input.actor.userId) ?? "unknown",
        agentId: input.actor.agentId ?? null,
        runId: input.actor.runId ?? null,
        action: input.action,
        entityType: "issue",
        entityId: input.issueId,
        issueId: input.issueId,
        details: input.details,
      });
    },
  };
}

export function mergeGateService(db: Db, options: { heartbeat?: IssueAssignmentWakeupDeps } = {}) {
  const deps = createMergeGateDependencies(db, options);
  return {
    evaluateAndMerge: (request: MergeGateRequest) => evaluateAndMerge(deps, request),
    reportRedMain: (input: Parameters<typeof reportRedMain>[1]) => reportRedMain(deps, input),
  };
}
