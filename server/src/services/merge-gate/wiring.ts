/** Database and GitHub wiring for the protected-main merge gate (FAC-840 B). */
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import {
  agents,
  documents,
  heartbeatRuns,
  issueDocuments,
  issueRelations,
  issues,
  type Db,
} from "@paperclipai/db";
import { logActivity } from "../activity-log.js";
import { resolveGitHubApiCredential } from "../git-credentials.js";
import { resolveGitHubOperationCredentials } from "../github-operation-credentials.js";
import { issueService } from "../issues.js";
import { createMergeGateGitHub } from "./github.js";
import { parseMergeReviewDocument, type MergeReviewAttestation } from "./policy.js";
import {
  evaluateAndMerge,
  MERGE_GATE_RED_MAIN_ORIGIN_KIND,
  MERGE_REVIEW_DOCUMENT_KEY,
  reportRedMain,
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

export function createMergeGateDependencies(db: Db): MergeGateDependencies {
  const issuesSvc = issueService(db);
  const loadIssue = async (companyId: string, issueId: string) => {
    const [row] = await db.select(gateIssueColumns).from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
    return row ?? null;
  };
  const loadAgentAdapter = async (companyId: string, agentId: string) => {
    const [row] = await db.select({ adapterType: agents.adapterType }).from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)));
    return row?.adapterType ?? null;
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
    loadAgentAdapter,
    async loadReviews(companyId, input) {
      const reference = `${input.repo}#${input.pullNumber}`;
      const rows = await db
        .select({
          issueId: issues.id,
          identifier: issues.identifier,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          body: documents.latestBody,
          writerAgentId: documents.updatedByAgentId,
          updatedAt: documents.updatedAt,
        })
        .from(issueDocuments)
        .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
        .innerJoin(issues, eq(issues.id, issueDocuments.issueId))
        .where(and(
          eq(issueDocuments.companyId, companyId),
          eq(issueDocuments.key, MERGE_REVIEW_DOCUMENT_KEY),
          input.reviewIssueIds.length > 0
            ? sql`(${inArray(issueDocuments.issueId, input.reviewIssueIds)} or ${documents.latestBody} ilike ${`%${reference}%`})`
            : sql`${documents.latestBody} ilike ${`%${reference}%`}`,
        ))
        .orderBy(documents.updatedAt)
        .limit(20);
      const attestations: MergeReviewAttestation[] = [];
      for (const row of rows) {
        const parsed = parseMergeReviewDocument(row.body);
        if (!parsed) continue;
        const reviewerAdapterType = row.writerAgentId ? await loadAgentAdapter(companyId, row.writerAgentId) : null;
        attestations.push({
          ...parsed,
          reviewIssueId: row.issueId,
          reviewIssueIdentifier: row.identifier,
          reviewIssueStatus: row.status,
          reviewerAgentId: row.writerAgentId,
          reviewerAdapterType,
          writtenByReviewer: Boolean(row.writerAgentId) && row.writerAgentId === row.assigneeAgentId,
        });
      }
      return attestations;
    },
    async ensureRedMainIssue(input) {
      const originId = `${input.repo.toLowerCase()}:${input.baseRef}`;
      return db.transaction(async tx => {
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

export function mergeGateService(db: Db) {
  const deps = createMergeGateDependencies(db);
  return {
    evaluateAndMerge: (request: MergeGateRequest) => evaluateAndMerge(deps, request),
    reportRedMain: (input: Parameters<typeof reportRedMain>[1]) => reportRedMain(deps, input),
  };
}
