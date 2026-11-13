import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, agentWakeupRequests, companies, createDb, executionWorkspaces, issueRecoveryActions, issueRelations,
  issues, issueThreadInteractions, issueTreeHolds, projects, workspaceOperations, type Db } from "@paperclipai/db";
import { ISSUE_WAIT_ORPHANED_WAKE_REASON } from "@paperclipai/shared";
import { recoveryService } from "../services/recovery/service.js";
import { issueService } from "../services/issues.js";
import { buildIssueBlockersResolvedWakeStateKey, ISSUE_BLOCKERS_RESOLVED_WAKE_REASON } from "../services/issue-dependency-wakeups.js";
import { MAX_ORPHAN_WAKES_PER_DAY, ORPHAN_REFUSED_WAKE_RETRY_MS, ORPHAN_WAIT_GRACE_MS, orphanWaitWakeKey,
  staleBlockersClearedWakeKey } from "../services/recovery/orphan-wait-wakeups.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_RECOVERY_ACTION_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();

// FAC-840 replay of STA-144: a task set itself blocked with nothing recorded to
// wake it. The scoped dependency worker checks it once after the status change;
// the check must name when to look again, and a wake that fails to enqueue must
// reach the worker's retry instead of being consumed as delivered.
(support.supported ? describe : describe.skip)("issue_wait_orphaned wakes", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("orphan-wait-");
    db = createDb(external ?? temporary!.connectionString);
    db.$client.options.onnotice = () => {};
  }, 30_000);
  afterEach(async () => {
    vi.useRealTimers(); vi.restoreAllMocks();
    await db.execute(sql`truncate companies cascade`);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  async function fixture(blockedTransitionAt: Date) {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Orphan", issuePrefix: `O${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "engineer", status: "idle" });
    const [issue] = await db.insert(issues).values({ companyId, title: "Blocked with no wait", status: "blocked",
      assigneeAgentId: agentId, blockedTransitionAt }).returning();
    return { companyId, agentId, issue };
  }

  // Records each delivered wake the way the queue does; `outcomes` scripts throws and refusals first.
  function wakeQueue(companyId: string, outcomes: Array<"throw" | "refuse"> = []) {
    const enqueueWakeup = vi.fn(async (agentId: string, input: Record<string, any>) => {
      const outcome = outcomes.shift();
      if (outcome === "throw") throw new Error("wake queue unavailable");
      if (outcome === "refuse") return null;
      const [row] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: input.source,
        triggerDetail: input.triggerDetail, reason: input.reason, payload: input.payload,
        idempotencyKey: input.idempotencyKey, status: "queued" }).returning();
      return { id: row.id };
    });
    return enqueueWakeup;
  }

  const orphanWakes = (companyId: string) => db.select().from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.companyId, companyId))
    .then(rows => rows.filter(row => row.reason === ISSUE_WAIT_ORPHANED_WAKE_REASON));

  it("names the grace deadline for a newly blocked orphan and wakes it there with no later write", async () => {
    const blockedAt = new Date(Date.now() - 60_000);
    const f = await fixture(blockedAt);
    const service = recoveryService(db, { enqueueWakeup: wakeQueue(f.companyId) as never });
    const check = async () => {
      const deadlines: number[] = [];
      const result = await service.reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId, issueId: f.issue.id,
        onDeferredDeadline: at => deadlines.push(at) });
      return { result, deadlines };
    };

    const early = await check();
    expect(early.result).toMatchObject({ orphanWaitsWoken: 0, enqueueFailed: 0 });
    expect(early.deadlines).toEqual([blockedAt.getTime() + ORPHAN_WAIT_GRACE_MS]);
    expect(await orphanWakes(f.companyId)).toHaveLength(0);

    // The worker comes back at that deadline; nothing else wrote the task.
    vi.useFakeTimers({ toFake: ["Date"], now: blockedAt.getTime() + ORPHAN_WAIT_GRACE_MS + 1_000 });
    const due = await check();
    expect(due.result).toMatchObject({ orphanWaitsWoken: 1, enqueueFailed: 0 });
    expect(due.deadlines).toEqual([]);
    const wakes = await orphanWakes(f.companyId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ agentId: f.agentId, idempotencyKey: orphanWaitWakeKey(f.issue.id, blockedAt) });

    // Delivered once per blocked cycle; no further deadline keeps the worker busy.
    const settled = await check();
    expect(settled.result.orphanWaitsWoken).toBe(0);
    expect(settled.deadlines).toEqual([]);
    expect(await orphanWakes(f.companyId)).toHaveLength(1);
  });

  it("hands a failed first enqueue to the worker's retry and delivers it on the next check", async () => {
    const f = await fixture(new Date(Date.now() - 2 * ORPHAN_WAIT_GRACE_MS));
    const enqueueWakeup = wakeQueue(f.companyId, ["throw"]);
    const service = recoveryService(db, { enqueueWakeup: enqueueWakeup as never });

    const failed = await service.reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId, issueId: f.issue.id,
      onDeferredDeadline: () => {} });
    expect(failed).toMatchObject({ orphanWaitsWoken: 0 });
    expect(failed.enqueueFailed).toBeGreaterThanOrEqual(1);
    expect(await orphanWakes(f.companyId)).toHaveLength(0);

    const retried = await service.reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId, issueId: f.issue.id,
      onDeferredDeadline: () => {} });
    expect(retried).toMatchObject({ orphanWaitsWoken: 1, enqueueFailed: 0 });
    expect(await orphanWakes(f.companyId)).toHaveLength(1);
  });

  // A native terminal failure blocks the task with a board-owned recovery
  // action, and a dependent with a done blocker belongs to the dependency
  // backstop: neither is an orphan, so neither wakes or keeps a deadline.
  it.each(["recovery action", "resolved blocker"] as const)("leaves a blocked task with a %s alone", async (path) => {
    const f = await fixture(new Date(Date.now() - 60_000));
    if (path === "recovery action") {
      await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issue.id,
        kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: f.agentId, cause: "native_terminal_failure",
        status: "active", evidence: {}, fingerprint: randomUUID(), nextAction: "Inspect the failure." });
    } else {
      const [blocker] = await db.insert(issues).values({ companyId: f.companyId, title: "Done blocker", status: "done" }).returning();
      await db.insert(issueRelations).values({ companyId: f.companyId, issueId: blocker.id, relatedIssueId: f.issue.id, type: "blocks" });
    }
    const enqueueWakeup = wakeQueue(f.companyId);
    const deadlines: number[] = [];
    const result = await recoveryService(db, { enqueueWakeup: enqueueWakeup as never }).reconcileResolvedDependencyWakeBackstop({
      companyId: f.companyId, issueId: f.issue.id, onDeferredDeadline: at => deadlines.push(at) });
    expect(result.orphanWaitsWoken).toBe(0);
    expect(enqueueWakeup.mock.calls.filter(([, input]) => input.reason === ISSUE_WAIT_ORPHANED_WAKE_REASON)).toHaveLength(0);
    expect(deadlines.filter(at => at === f.issue.blockedTransitionAt!.getTime() + ORPHAN_WAIT_GRACE_MS)).toEqual([]);
    expect(await orphanWakes(f.companyId)).toHaveLength(0);
  });

  // FAC-851: the assignee re-blocks its own task after its only blocker is
  // done. The dependency backstop withholds its wake (a self-block must not
  // loop), so the done relation waits for nothing. STA-361: such a task, with
  // no other wait recorded, returns to todo and its assignee is woken, within
  // the same daily cap as an orphan wake.
  describe("self-blocked after its blocker was done", () => {
    async function selfBlocked(blockedAt: Date, opts: { blockerFinalizing?: boolean } = {}) {
      const f = await fixture(blockedAt);
      let executionWorkspaceId: string | null = null;
      if (opts.blockerFinalizing) {
        const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Dependency" }).returning();
        const [workspace] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, projectId: project.id,
          mode: "isolated_workspace", strategyType: "git_worktree", name: "Blocker workspace" }).returning();
        executionWorkspaceId = workspace.id;
      }
      const [blocker] = await db.insert(issues).values({ companyId: f.companyId, title: "Done blocker", status: "done",
        completedAt: new Date(blockedAt.getTime() - 10 * 60_000), executionWorkspaceId }).returning();
      await db.insert(issueRelations).values({ companyId: f.companyId, issueId: blocker.id, relatedIssueId: f.issue.id, type: "blocks" });
      if (executionWorkspaceId) {
        // The blocker ran on its workspace but has not synced it back yet.
        await db.insert(workspaceOperations).values({ companyId: f.companyId, executionWorkspaceId, issueId: blocker.id,
          phase: "adapter_execute", status: "succeeded", startedAt: new Date(blockedAt.getTime() - 60_000) });
      }
      await db.insert(activityLog).values({ companyId: f.companyId, actorType: "agent", actorId: f.agentId, agentId: f.agentId,
        action: "issue.updated", entityType: "issue", entityId: f.issue.id, details: { status: "blocked" }, createdAt: blockedAt });
      return { ...f, blocker };
    }
    const check = async (service: ReturnType<typeof recoveryService>, f: { companyId: string; issue: { id: string } }) => {
      const deadlines: number[] = [];
      const result = await service.reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId, issueId: f.issue.id,
        onDeferredDeadline: at => deadlines.push(at) });
      return { result, deadlines };
    };
    const inboxReason = async (f: { companyId: string; issue: { id: string } }) => {
      const rows = await issueService(db).list(f.companyId, { attention: "blocked" }) as Array<{ id: string; blockedInboxAttention?: { reason?: string } | null }>;
      return rows.find(row => row.id === f.issue.id)?.blockedInboxAttention?.reason ?? null;
    };
    const dependencyWakes = (companyId: string) => db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId))
      .then(rows => rows.filter(row => row.reason === ISSUE_BLOCKERS_RESOLVED_WAKE_REASON));
    const statusOf = (issueId: string) => db.select({ status: issues.status }).from(issues)
      .where(eq(issues.id, issueId)).then(rows => rows[0]?.status);

    it("returns to todo and wakes its assignee once at its grace deadline with no later write", async () => {
      const blockedAt = new Date(Date.now() - 60_000);
      const f = await selfBlocked(blockedAt);
      const service = recoveryService(db, { enqueueWakeup: wakeQueue(f.companyId) as never });
      expect(await inboxReason(f)).toBe("blocked_without_wait_path");

      const early = await check(service, f);
      expect(early.result).toMatchObject({ healed: 0, selfBlockedSkipped: 1, orphanWaitsWoken: 0, staleBlockersCleared: 0,
        enqueueFailed: 0 });
      expect(early.deadlines).toEqual([blockedAt.getTime() + ORPHAN_WAIT_GRACE_MS]);
      expect(await statusOf(f.issue.id)).toBe("blocked");

      // The worker returns at that deadline; nothing else wrote the task.
      vi.useFakeTimers({ toFake: ["Date"], now: blockedAt.getTime() + ORPHAN_WAIT_GRACE_MS + 1_000 });
      const due = await check(service, f);
      expect(due.result).toMatchObject({ healed: 0, selfBlockedSkipped: 1, orphanWaitsWoken: 0, staleBlockersCleared: 1,
        enqueueFailed: 0 });
      expect(due.deadlines).toEqual([]);
      expect(await statusOf(f.issue.id)).toBe("todo");
      expect(await orphanWakes(f.companyId)).toHaveLength(0);
      expect(await dependencyWakes(f.companyId)).toEqual([expect.objectContaining({ agentId: f.agentId,
        idempotencyKey: staleBlockersClearedWakeKey(f.issue.id, blockedAt) })]);
      const [audit] = await db.select().from(activityLog).where(eq(activityLog.action, "issue.stale_blockers_cleared"));
      expect(audit).toMatchObject({ entityId: f.issue.id, actorType: "system" });

      // A todo task is no longer the sweep's: nothing more is written or scheduled.
      const settled = await check(service, f);
      expect(settled.result).toMatchObject({ orphanWaitsWoken: 0, staleBlockersCleared: 0 });
      expect(settled.deadlines).toEqual([]);
      expect(await dependencyWakes(f.companyId)).toHaveLength(1);
    });

    it("shares the daily cap with orphan wakes, so a re-blocking owner cannot loop", async () => {
      const f = await selfBlocked(new Date(Date.now() - 2 * ORPHAN_WAIT_GRACE_MS));
      await db.insert(agentWakeupRequests).values(Array.from({ length: MAX_ORPHAN_WAKES_PER_DAY }, (_, index) => ({
        companyId: f.companyId, agentId: f.agentId, source: "automation", triggerDetail: "system",
        reason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON, payload: { issueId: f.issue.id }, status: "completed",
        idempotencyKey: staleBlockersClearedWakeKey(f.issue.id, new Date(Date.now() - (index + 3) * 60 * 60_000)) })));
      const { result } = await check(recoveryService(db, { enqueueWakeup: wakeQueue(f.companyId) as never }), f);
      expect(result).toMatchObject({ orphanWaitsWoken: 0, staleBlockersCleared: 0 });
      expect(await statusOf(f.issue.id)).toBe("blocked");
      expect(await inboxReason(f)).toBe("blocked_without_wait_path");
    });

    it("stays blocked when its only blocker is cancelled", async () => {
      const blockedAt = new Date(Date.now() - 2 * ORPHAN_WAIT_GRACE_MS);
      const f = await fixture(blockedAt);
      const [blocker] = await db.insert(issues).values({ companyId: f.companyId, title: "Cancelled blocker",
        status: "cancelled" }).returning();
      await db.insert(issueRelations).values({ companyId: f.companyId, issueId: blocker.id, relatedIssueId: f.issue.id, type: "blocks" });
      const enqueueWakeup = wakeQueue(f.companyId);
      const { result } = await check(recoveryService(db, { enqueueWakeup: enqueueWakeup as never }), f);
      expect(result).toMatchObject({ healed: 0, orphanWaitsWoken: 0, staleBlockersCleared: 0 });
      expect(await statusOf(f.issue.id)).toBe("blocked");
      expect(enqueueWakeup).not.toHaveBeenCalled();
    });

    it("stops at the daily cap and stays visible", async () => {
      const f = await selfBlocked(new Date(Date.now() - 2 * ORPHAN_WAIT_GRACE_MS));
      await db.insert(agentWakeupRequests).values(Array.from({ length: MAX_ORPHAN_WAKES_PER_DAY }, (_, index) => ({
        companyId: f.companyId, agentId: f.agentId, source: "automation", triggerDetail: "system",
        reason: ISSUE_WAIT_ORPHANED_WAKE_REASON, payload: { issueId: f.issue.id }, status: "completed",
        idempotencyKey: `earlier-cycle-${index}` })));
      const { result, deadlines } = await check(recoveryService(db, { enqueueWakeup: wakeQueue(f.companyId) as never }), f);
      expect(result.orphanWaitsWoken).toBe(0);
      expect(deadlines).toEqual([]);
      expect(await orphanWakes(f.companyId)).toHaveLength(MAX_ORPHAN_WAKES_PER_DAY);
      expect(await inboxReason(f)).toBe("blocked_without_wait_path");
    });

    it("returns a board-blocked dependent to todo once its dependency wake for this cycle was spent", async () => {
      const blockedAt = new Date(Date.now() - 2 * ORPHAN_WAIT_GRACE_MS);
      const f = await fixture(blockedAt);
      const [blocker] = await db.insert(issues).values({ companyId: f.companyId, title: "Done blocker", status: "done" }).returning();
      await db.insert(issueRelations).values({ companyId: f.companyId, issueId: blocker.id, relatedIssueId: f.issue.id, type: "blocks" });
      const idempotencyKey = buildIssueBlockersResolvedWakeStateKey({ dependentIssueId: f.issue.id,
        blockerIssueIds: [blocker.id], blockedTransitionAt: blockedAt });
      await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
        triggerDetail: "system", reason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON, payload: { issueId: f.issue.id },
        status: "completed", idempotencyKey });
      expect(await inboxReason(f)).toBe("blocked_without_wait_path");
      const { result } = await check(recoveryService(db, { enqueueWakeup: wakeQueue(f.companyId) as never }), f);
      expect(result).toMatchObject({ healed: 0, existingWakeSkipped: 1, orphanWaitsWoken: 0, staleBlockersCleared: 1 });
      expect(await statusOf(f.issue.id)).toBe("todo");
      expect(await dependencyWakes(f.companyId)).toEqual(expect.arrayContaining([expect.objectContaining({
        agentId: f.agentId, idempotencyKey: staleBlockersClearedWakeKey(f.issue.id, blockedAt) })]));
    });

    it.each(["pending interaction", "pause hold", "finalizing blocker", "dependency wake in flight"] as const)(
      "stays quiet with a %s", async (path) => {
        const blockedAt = new Date(Date.now() - 2 * ORPHAN_WAIT_GRACE_MS);
        const f = await selfBlocked(blockedAt, { blockerFinalizing: path === "finalizing blocker" });
        if (path === "pending interaction") {
          await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issue.id,
            kind: "ask_user_questions", status: "pending", title: "Which vendor?", payload: { version: 1, questions: [{ id: "q",
              prompt: "Which vendor?", options: [{ id: "a", label: "A" }], selectionMode: "single", required: true }] } });
        } else if (path === "pause hold") {
          await db.insert(issueTreeHolds).values({ companyId: f.companyId, rootIssueId: f.issue.id, mode: "pause", status: "active",
            createdByActorType: "user", createdByUserId: "board-1", releasePolicy: { strategy: "manual", note: "hold" } });
        } else if (path === "dependency wake in flight") {
          await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
            triggerDetail: "system", reason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON, payload: { issueId: f.issue.id },
            status: "deferred_issue_execution", idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
              dependentIssueId: f.issue.id, blockerIssueIds: [f.blocker.id], blockedTransitionAt: blockedAt }) });
        }
        const enqueueWakeup = wakeQueue(f.companyId);
        const { result, deadlines } = await check(recoveryService(db, { enqueueWakeup: enqueueWakeup as never }), f);
        expect(result.orphanWaitsWoken).toBe(0);
        expect(result.staleBlockersCleared).toBe(0);
        expect(await statusOf(f.issue.id)).toBe("blocked");
        expect(deadlines).toEqual([]);
        expect(enqueueWakeup.mock.calls.filter(([, input]) => input.reason === ISSUE_WAIT_ORPHANED_WAKE_REASON)).toHaveLength(0);
        expect(await orphanWakes(f.companyId)).toHaveLength(0);
        if (path !== "pause hold") expect(await inboxReason(f)).not.toBe("blocked_without_wait_path");
      });
  });

  it("keeps a refused wake as a deadline instead of consuming it as delivered", async () => {
    const f = await fixture(new Date(Date.now() - 2 * ORPHAN_WAIT_GRACE_MS));
    const service = recoveryService(db, { enqueueWakeup: wakeQueue(f.companyId, ["refuse"]) as never });
    const deadlines: number[] = [];
    const before = Date.now();
    const refused = await service.reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId, issueId: f.issue.id,
      onDeferredDeadline: at => deadlines.push(at) });
    expect(refused).toMatchObject({ orphanWaitsWoken: 0, enqueueFailed: 0 });
    expect(deadlines).toHaveLength(1);
    expect(deadlines[0]).toBeGreaterThanOrEqual(before + ORPHAN_REFUSED_WAKE_RETRY_MS);

    vi.useFakeTimers({ toFake: ["Date"], now: deadlines[0]! + 1_000 });
    const offered = await service.reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId, issueId: f.issue.id,
      onDeferredDeadline: () => {} });
    expect(offered).toMatchObject({ orphanWaitsWoken: 1 });
    expect(await orphanWakes(f.companyId)).toHaveLength(1);
  });
});
