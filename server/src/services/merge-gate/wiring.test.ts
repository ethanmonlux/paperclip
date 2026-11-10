import type { Db } from "@paperclipai/db";
import {
  agents, authUsers, companies, companyMemberships, createDb, documentRevisions, documents, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns, issueDocuments, issues,
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
    const body = `pullRequest: ethanmonlux/facette#704\nreviewedSha: ${HEAD}\nscope: full\np0: 0\np1: 0\np2: none`;
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
