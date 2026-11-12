import type { Db } from "@paperclipai/db";
import {
  activityLog, agents, authUsers, companies, companyMemberships, createDb, documentRevisions, documents, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns, issueDocuments, issueThreadInteractions, issues,
} from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { MERGE_LOCK_BUSY } from "./service.js";
import { createMergeGateDependencies } from "./wiring.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_MERGE_GATE_WIRING_TEST_DATABASE_URL");
const support = external ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping merge gate wiring database tests: ${support.reason}`);

const HEAD = "a".repeat(40);
const board = { type: "board" as const, userId: "gate-owner" };

describe.skipIf(!support.supported)("merge gate wiring", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("paperclip-merge-gate-wiring");
    db = createDb(external ?? database!.connectionString, { maxConnections: 4 });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });
  beforeEach(async () => {
    await db.execute(sql`truncate table companies restart identity cascade`);
  });

  async function fixture() {
    await db.insert(authUsers).values({ id: "gate-owner", name: "Owner", email: "gate-owner@paperclip.test", createdAt: new Date(), updatedAt: new Date() })
      .onConflictDoNothing();
    const [company] = await db.insert(companies).values({ name: "Merge gate", issuePrefix: "MG", defaultResponsibleUserId: "gate-owner" }).returning();
    await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: "gate-owner", status: "active", membershipRole: "member" });
    const agent = async (name: string, adapterType: string, runtimeConfig: Record<string, unknown> = {}) => (await db.insert(agents)
      .values({ companyId: company!.id, name, status: "idle", adapterType, adapterConfig: {}, runtimeConfig }).returning())[0]!;
    const issue = async (title: string, assigneeAgentId: string | null, status = "in_progress") => (await db.insert(issues)
      .values({ companyId: company!.id, title, status, priority: "high", assigneeAgentId, responsibleUserId: "gate-owner" }).returning())[0]!;
    const run = async (agentId: string, issueId: string, usageJson: Record<string, unknown> | null) => (await db.insert(heartbeatRuns)
      .values({ companyId: company!.id, agentId, issueId, status: "succeeded", invocationSource: "assignment", triggerDetail: "system",
        startedAt: new Date(), finishedAt: new Date(), usageJson }).returning())[0]!;
    return { company: company!, agent, issue, run };
  }

  it("opens one red-main owner and wakes its urgent-capable assignee only after the issue is committed", async () => {
    const f = await fixture();
    const repair = await f.agent("Repair Engineer", "claude_local", { heartbeat: { urgentLane: true } });
    const visibleAtWake: unknown[] = [];
    const wakeup = vi.fn(async (_agentId: string, opts: { payload?: Record<string, unknown> | null }) => {
      // A separate connection sees the issue only if its transaction committed.
      const [row] = await db.select({ id: issues.id }).from(issues).where(eq(issues.id, String(opts.payload?.issueId)));
      visibleAtWake.push(row?.id ?? null);
      return null;
    });
    const deps = createMergeGateDependencies(db, { heartbeat: { wakeup } });
    const input = { companyId: f.company.id, repo: "ethanmonlux/facette", baseRef: "main", baseSha: HEAD, failing: ["windows-fast"],
      fallbackAssigneeAgentId: null, projectId: null, evidence: null, actor: board, createIfMissing: true };
    const first = await deps.ensureRedMainIssue(input);
    const second = await deps.ensureRedMainIssue(input);
    expect(first).toMatchObject({ created: true, issue: { priority: "critical", assigneeAgentId: repair.id } });
    expect(second).toMatchObject({ created: false, issue: { id: first!.issue.id } });
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith(repair.id, expect.objectContaining({
      source: "assignment", reason: "issue_assigned", payload: expect.objectContaining({ issueId: first!.issue.id }),
    }));
    expect(visibleAtWake).toEqual([first!.issue.id]);
  });

  it("reads review and author model families from the recorded runs, not adapter configuration", async () => {
    const f = await fixture();
    // Both on one adapter: the runs, not the adapter, say which model did the work.
    const implementer = await f.agent("Implementer", "paperclip_runner");
    const reviewer = await f.agent("Reviewer", "paperclip_runner");
    const task = await f.issue("Task", implementer.id);
    const reviewIssue = await f.issue("Review", reviewer.id, "done");
    await f.run(implementer.id, task.id, { model: "claude-opus-5-5", provider: "anthropic" });
    // A run killed before recording usage is attributed to the agent's other runs.
    await f.run(implementer.id, task.id, null);
    // The implementer is reconfigured after authoring; history is unchanged.
    await db.update(agents).set({ adapterType: "codex_local" }).where(eq(agents.id, implementer.id));
    const reviewRun = await f.run(reviewer.id, reviewIssue.id, { model: "gpt-6.1-sol", provider: "openai" });
    const body = `pullRequest: ethanmonlux/facette#704\nreviewedSha: ${HEAD}\nscope: full\np0: 0\np1: 0\np2: none\nsourceAuthorAgentIds: ${implementer.id}`;
    const [document] = await db.insert(documents).values({ companyId: f.company.id, latestBody: body, updatedByAgentId: reviewer.id }).returning();
    await db.insert(documentRevisions).values({ companyId: f.company.id, documentId: document!.id, revisionNumber: 1, body,
      createdByAgentId: reviewer.id, createdByRunId: reviewRun.id });
    await db.insert(issueDocuments).values({ companyId: f.company.id, issueId: reviewIssue.id, documentId: document!.id, key: "merge-review" });

    const deps = createMergeGateDependencies(db);
    await expect(deps.loadReviews(f.company.id, { reviewIssueIds: [reviewIssue.id], repo: "ethanmonlux/facette", pullNumber: 704 }))
      .resolves.toMatchObject([{ reviewerAgentId: reviewer.id, reviewerModelFamilies: ["openai"], writtenByReviewer: true, reviewedSha: HEAD }]);
    await expect(deps.loadTaskAuthorship(f.company.id, { issueId: task.id, excludeAgentId: null }))
      .resolves.toEqual({ agentIds: [implementer.id], modelFamilies: ["anthropic"] });

    // STA-218: a reviewer that ran on the task stays a potential author; only
    // the merging coordinator's runs are left out.
    const coordinator = await f.agent("Coordinator", "codex_local");
    await f.run(coordinator.id, task.id, { model: "gpt-6.1-sol", provider: "openai" });
    await f.run(reviewer.id, task.id, { model: "gpt-6.1-sol", provider: "openai" });
    await expect(deps.loadTaskAuthorship(f.company.id, { issueId: task.id, excludeAgentId: null,
      sourceAuthorAgentIds: [implementer.id] }))
      .resolves.toEqual({ agentIds: [implementer.id], modelFamilies: ["anthropic"] });
    await expect(deps.loadTaskAuthorship(f.company.id, { issueId: task.id, excludeAgentId: null,
      sourceAuthorAgentIds: ["00000000-0000-4000-8000-000000000000"] })).resolves.toBeNull();
    await expect(deps.loadTaskAuthorship(f.company.id, { issueId: task.id, excludeAgentId: coordinator.id }))
      .resolves.toEqual({ agentIds: [implementer.id, reviewer.id].sort(), modelFamilies: ["anthropic", "openai"] });

    // An agent whose only runs on the task recorded no model leaves authorship unknown.
    const silent = await f.agent("Silent", "process");
    await f.run(silent.id, task.id, null);
    await expect(deps.loadTaskAuthorship(f.company.id, { issueId: task.id, excludeAgentId: coordinator.id })).resolves.toBeNull();

    // A later revision written by someone else is not the reviewer's record.
    await db.insert(documentRevisions).values({ companyId: f.company.id, documentId: document!.id, revisionNumber: 2, body,
      createdByAgentId: implementer.id, createdByRunId: null });
    await expect(deps.loadReviews(f.company.id, { reviewIssueIds: [reviewIssue.id], repo: "ethanmonlux/facette", pullNumber: 704 }))
      .resolves.toMatchObject([{ reviewerAgentId: implementer.id, reviewerModelFamilies: [], writtenByReviewer: false }]);
  });

  it("recognizes the STA-293 legacy coordinator handoff only with a recorded engineer run", async () => {
    const f = await fixture();
    const coordinator = await f.agent("Coordinator", "codex_local");
    const engineer = await f.agent("Engineer", "claude_local");
    const task = await f.issue("Legacy task", coordinator.id);
    const at = (minute: number) => new Date(Date.UTC(2026, 10, 11, 10, minute));
    const event = async (action: string, actorType: string, actorId: string, details: Record<string, unknown>, minute: number) =>
      db.insert(activityLog).values({ companyId: f.company.id, entityType: "issue", entityId: task.id,
        action, actorType, actorId, details, createdAt: at(minute) });
    await event("issue.created", "user", "gate-owner", { assigneeAgentId: coordinator.id }, 0);
    await event("issue.updated", "agent", coordinator.id,
      { changes: { assigneeAgentId: { from: coordinator.id, to: engineer.id } } }, 10);
    const deps = createMergeGateDependencies(db);
    expect(await deps.loadLegacyDelegation(f.company.id, task.id, coordinator.id)).toBe(false);
    await db.insert(heartbeatRuns).values({ companyId: f.company.id, issueId: task.id, agentId: engineer.id,
      status: "succeeded", invocationSource: "assignment", triggerDetail: "system", startedAt: at(15), finishedAt: at(18) });
    await event("issue.updated", "agent", engineer.id,
      { changes: { assigneeAgentId: { from: engineer.id, to: coordinator.id } } }, 20);
    expect(await deps.loadLegacyDelegation(f.company.id, task.id, coordinator.id)).toBe(true);
    expect(await deps.loadLegacyDelegation(f.company.id, task.id, engineer.id)).toBe(false);
    await event("issue.updated", "agent", coordinator.id,
      { changes: { assigneeAgentId: { from: coordinator.id, to: engineer.id } } }, 30);
    expect(await deps.loadLegacyDelegation(f.company.id, task.id, coordinator.id)).toBe(false);
  });

  it("recognizes only an accepted, addressed STA-315 review routing record", async () => {
    const f = await fixture();
    const engineer = await f.agent("Engineer", "claude_local");
    const coordinator = await f.agent("Coordinator", "codex_local");
    const outsider = await f.agent("Outsider", "codex_local");
    const task = await f.issue("Engineer-created task", engineer.id);
    const deps = createMergeGateDependencies(db);
    const payload = { version: 1 as const, prompt: "Route independent review", target: {
      type: "issue_document" as const, issueId: task.id, key: "handoff", revisionId: crypto.randomUUID(),
    } };
    await db.insert(issueThreadInteractions).values({ companyId: f.company.id, issueId: task.id,
      kind: "request_confirmation", status: "accepted", createdByAgentId: engineer.id,
      addresseeAgentId: coordinator.id, resolvedByAgentId: coordinator.id,
      title: "Route cross-model review: task", idempotencyKey: `confirmation:${task.id}:route-review:head:round1`, payload });
    expect(await deps.loadAcceptedCoordinatorRouting(f.company.id, task.id, engineer.id, coordinator.id)).toBe(true);
    expect(await deps.loadAcceptedCoordinatorRouting(f.company.id, task.id, engineer.id, outsider.id)).toBe(false);
    expect(await deps.loadAcceptedCoordinatorRouting(f.company.id, task.id, coordinator.id, engineer.id)).toBe(false);
    await db.update(issueThreadInteractions).set({ status: "rejected" }).where(eq(issueThreadInteractions.issueId, task.id));
    expect(await deps.loadAcceptedCoordinatorRouting(f.company.id, task.id, engineer.id, coordinator.id)).toBe(false);
  });

  it("holds one merge lock per repository branch across connections", async () => {
    const deps = createMergeGateDependencies(db);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; });
    const first = deps.withMergeLock("merge-gate:ethanmonlux/facette:main", async () => { entered(); await held; return "merged"; });
    await inside;
    await expect(deps.withMergeLock("merge-gate:ethanmonlux/facette:main", async () => "second")).resolves.toBe(MERGE_LOCK_BUSY);
    await expect(deps.withMergeLock("merge-gate:ethanmonlux/facette:release", async () => "other branch")).resolves.toBe("other branch");
    release();
    await expect(first).resolves.toBe("merged");
    await expect(deps.withMergeLock("merge-gate:ethanmonlux/facette:main", async () => "after")).resolves.toBe("after");
  });
});
