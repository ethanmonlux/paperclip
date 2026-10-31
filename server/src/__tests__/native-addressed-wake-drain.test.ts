import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { createRunDispatch } from "../modules/run-dispatch/index.js";
import { createPostgresWakeQueueAdapter } from "../modules/wake-queue/adapters/postgres.js";
import { createReleaseIssueExecution } from "../modules/wake-queue/application/use-cases.js";
import type { PostCommitEffect } from "../modules/wake-queue/index.js";
import { createHeartbeatQueue, type HeartbeatQueueDependencies } from "../services/heartbeat/queue.js";
import { createHeartbeatRunPreparation } from "../services/heartbeat/run-preparation.js";
import { createHeartbeatRunState } from "../services/heartbeat/run-state.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// FAC-760 STA-43 (founder 3b8f05fe): two addressed routing cards for the same
// Coordinator were deferred behind the source Engineer's execution. The first
// card expired, the release promoted its stale wake, the dispatch gate
// cancelled that run as `issue_assignee_changed`, and the live card's wake was
// never promoted again. These cases drive the real wake-queue release and the
// real queued-run claim gate against Postgres. No provider adapter runs.

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping native addressed wake drain tests on this host: ${support.reason ?? "unsupported environment"}`);
}

type Run = typeof heartbeatRuns.$inferSelect;

describeEmbedded("native addressed wake drain (STA-43)", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-addressed-wake-drain-");
    db = createDb(temporary.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  const at = (base: Date, seconds: number) => new Date(base.getTime() + seconds * 1000);

  /**
   * One process instance: the real wake-queue release and the real heartbeat
   * queue claim gate. Creating a second instance models a server restart; all
   * state the gate and the drain read is persisted.
   */
  function services() {
    const releaseIssueExecution = createReleaseIssueExecution({
      issueLock: createPostgresWakeQueueAdapter(db, {
        resolveResponsibleUserId: async () => "responsible-user",
        getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
        resolveSessionBeforeForWakeup: async () => null,
      }),
      recovery: { escalateStrandedAssignedIssue: async () => {}, escalateStrandedRecoveryIssueInPlace: async () => {} },
    });
    const released: PostCommitEffect[] = [];
    const releaseIssueExecutionAndPromote: HeartbeatQueueDependencies["releaseIssueExecutionAndPromote"] =
      async (run, options = {}) => {
        const result = await releaseIssueExecution({
          companyId: run.companyId, runId: run.id, now: new Date(),
          suppressImmediateRecovery: options.suppressImmediateRecovery,
          ...("undispatchedGateCancellation" in options
            ? { undispatchedGateCancellation: (options as { undispatchedGateCancellation?: boolean }).undispatchedGateCancellation }
            : {}),
        });
        (options.deferredPostCommitEffects ?? released).push(...result.postCommitEffects);
        return result;
      };
    const state = createHeartbeatRunState(db);
    const preparation = createHeartbeatRunPreparation(db);
    const deps = {
      ...preparation,
      ...state,
      getAgent: async (agentId: string) => db.select().from(agents).where(eq(agents.id, agentId)).then(rows => rows[0] ?? null),
      options: {},
      setRunStatus: async (id: string, status: string, patch?: Partial<Run>) =>
        db.update(heartbeatRuns).set({ ...patch, status }).where(eq(heartbeatRuns.id, id)).returning().then(rows => rows[0] ?? null),
      setWakeupStatus: async () => undefined,
      appendRunEvent: async () => undefined,
      finalizeAgentStatus: async () => undefined,
      getAgentInvokability: async () => ({ invokable: true }),
      // Upstream's claim gate also asks this; the fork does not read it. It is
      // here only so the upstream-only receipt runs the same cases.
      canStartNewExternalBotWork: async () => true,
      getWorktreeExecutionCutoff: async () => null,
      applyRunDispatchPostCommitEffects: () => {},
      issuesSvc: {
        getDependencyReadiness: vi.fn(),
        listDependencyReadiness: async () => new Map(),
      },
      treeControlSvc: { getActivePauseHoldGate: async () => null },
      budgets: { getInvocationBlock: async () => null },
      instanceSettings: { getExperimental: vi.fn() },
      runDispatch: createRunDispatch(db),
      wakeQueue: { createAdmissionTransactionScope: vi.fn(), admitWakeBehindIssueExecution: vi.fn() },
      activeRunExecutions: new Set<string>(),
      activeRunExecutionPromises: new Set<Promise<void>>(),
      activeWakeupPromises: new Set<Promise<unknown>>(),
      liveRunExecutions: { has: () => false },
      isHeartbeatRunTerminalStatus: (status: string | null | undefined) =>
        ["succeeded", "failed", "cancelled", "timed_out"].includes(status ?? ""),
      isSameTaskScope: (left: string | null, right: string | null) => left === right,
      runTaskKey: (run: Run) => typeof run.contextSnapshot?.issueId === "string" ? run.contextSnapshot.issueId : null,
      filterZombieCoalesceTarget: <T extends { id: string; status: string }>(run: T | null) => run,
      getSchedulingSuppression: async () => ({ suppressed: false, reason: null }),
      executeRun: async () => undefined,
      applyWakeQueuePostCommitEffects: async () => undefined,
      releaseIssueExecutionAndPromote,
      publishRunLifecyclePluginEvent: () => {},
      cancelRunInternal: async () => undefined,
      cancelActiveForAgentInternal: async () => undefined,
      resumeExecutionWaitComments: async () => undefined,
      resumeQueuedCommentInterrupt: async () => undefined,
      resumeSavedLegacyComments: async () => undefined,
      formatIssueIdentifierLink: (_identifier: string | null, fallback: string) => fallback,
      sweepPendingCleanupLeases: vi.fn(),
    } as unknown as HeartbeatQueueDependencies;
    const queue = createHeartbeatQueue(db, deps);
    return { releaseIssueExecution, queue, runDispatch: deps.runDispatch };
  }

  async function fixture() {
    const companyId = randomUUID(), engineerId = randomUUID(), coordinatorId = randomUUID();
    const issueId = randomUUID(), engineerRunId = randomUUID();
    const t0 = new Date(Date.now() - 10 * 60_000);
    await db.insert(companies).values({
      id: companyId, name: "Addressed wake fixture", issuePrefix: `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values([
      { id: engineerId, companyId, name: "Engineer", role: "engineer", status: "idle", adapterType: "codex_local",
        runtimeConfig: { heartbeat: { wakeOnDemand: true } } },
      { id: coordinatorId, companyId, name: "Coordinator", role: "engineer", status: "idle", adapterType: "codex_local",
        runtimeConfig: { heartbeat: { wakeOnDemand: true } } },
    ]);
    await db.insert(issues).values({
      id: issueId, companyId, title: "Source with routing card", status: "in_review",
      assigneeAgentId: engineerId, responsibleUserId: "responsible-user",
    });
    // The Engineer's execution holds the task while the routing cards arrive.
    await db.insert(heartbeatRuns).values({
      id: engineerRunId, companyId, agentId: engineerId, invocationSource: "automation", status: "running",
      runtimeMode: "legacy", startedAt: at(t0, -60), createdAt: at(t0, -60), contextSnapshot: { issueId },
    });
    await db.update(issues).set({ executionRunId: engineerRunId, executionLockedAt: at(t0, -60) }).where(eq(issues.id, issueId));

    /** An addressed routing card plus its wake, deferred behind the Engineer's execution. */
    async function card(offsetSeconds: number, status: string = "pending") {
      const interactionId = randomUUID(), wakeId = randomUUID();
      await db.insert(issueThreadInteractions).values({
        id: interactionId, companyId, issueId, kind: "request_confirmation", status,
        sourceRunId: engineerRunId, createdByAgentId: engineerId, addresseeAgentId: coordinatorId,
        payload: { version: 1, prompt: "Route this source handoff to independent review." },
        createdAt: at(t0, offsetSeconds),
      });
      const context = {
        issueId, taskId: issueId, interactionId, interactionKind: "request_confirmation",
        sourceCommentId: null, sourceRunId: engineerRunId, wakeReason: "interaction_pending", source: "issue.interaction.created",
      };
      await db.insert(agentWakeupRequests).values({
        id: wakeId, companyId, agentId: coordinatorId, source: "automation", triggerDetail: "system",
        reason: "interaction_pending", status: "deferred_issue_execution",
        requestedByActorType: "agent", requestedByActorId: engineerId,
        idempotencyKey: `interaction-pending:${interactionId}`,
        payload: {
          issueId, interactionId, interactionKind: "request_confirmation", sourceCommentId: null,
          sourceRunId: engineerRunId, mutation: "interaction", _paperclipWakeContext: context,
        },
        requestedAt: at(t0, offsetSeconds), createdAt: at(t0, offsetSeconds), updatedAt: at(t0, offsetSeconds),
      });
      return { interactionId, wakeId };
    }
    const setCard = (interactionId: string, status: string) =>
      db.update(issueThreadInteractions).set({ status, resolvedAt: status === "pending" ? null : new Date() })
        .where(eq(issueThreadInteractions.id, interactionId));
    const finishEngineer = (status: "succeeded" | "failed" | "cancelled" = "succeeded") =>
      db.update(heartbeatRuns).set({ status, finishedAt: new Date() }).where(eq(heartbeatRuns.id, engineerRunId));
    const wake = (wakeId: string) =>
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)).then(rows => rows[0]!);
    const coordinatorRuns = () => db.select().from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, coordinatorId)));
    const issue = () => db.select().from(issues).where(eq(issues.id, issueId)).then(rows => rows[0]!);
    return {
      companyId, engineerId, coordinatorId, issueId, engineerRunId, t0,
      card, setCard, finishEngineer, wake, coordinatorRuns, issue,
    };
  }

  /** Claims every queued Coordinator run through the real gate, repeatedly, as the scheduler would. */
  async function claimCoordinatorRuns(f: Awaited<ReturnType<typeof fixture>>, svc = services()) {
    const claimed: Run[] = [];
    for (let pass = 0; pass < 5; pass += 1) {
      const queued = (await f.coordinatorRuns()).filter(run => run.status === "queued");
      if (queued.length === 0) break;
      for (const run of queued) {
        const result = await svc.queue.claimQueuedRun(run, undefined, []);
        if (result) claimed.push(result);
      }
    }
    return claimed;
  }

  const boundTo = (run: Run, issueId: string, interactionId: string) => {
    const context = (run.contextSnapshot ?? {}) as Record<string, unknown>;
    return context.issueId === issueId && context.interactionId === interactionId;
  };

  describe("live card after a stale card", () => {
    it.each([
      ["expired"],
      ["cancelled"],
      ["rejected"],
    ])("claims the live card's addressee run when the earlier card was %s before the release", async (staleStatus) => {
      const f = await fixture();
      const stale = await f.card(10);
      const live = await f.card(40);
      await f.setCard(stale.interactionId, staleStatus);
      await f.finishEngineer();
      const svc = services();
      await svc.releaseIssueExecution({ companyId: f.companyId, runId: f.engineerRunId, now: new Date() });
      const claimed = await claimCoordinatorRuns(f, svc);

      expect(claimed).toHaveLength(1);
      expect(boundTo(claimed[0]!, f.issueId, live.interactionId)).toBe(true);
      expect(claimed[0]!.agentId).toBe(f.coordinatorId);
      expect((await f.wake(live.wakeId)).status).not.toBe("deferred_issue_execution");
      // The stale card's wake never became a dispatched run.
      const staleRuns = (await f.coordinatorRuns()).filter(run => boundTo(run, f.issueId, stale.interactionId));
      expect(staleRuns.every(run => run.status === "cancelled")).toBe(true);
      expect((await f.wake(stale.wakeId)).status).not.toBe("deferred_issue_execution");
      // The source task stays with its Engineer, untouched.
      expect(await f.issue()).toMatchObject({ assigneeAgentId: f.engineerId, status: "in_review", checkoutRunId: null });
    });

    it("retires a stale card's deferred wake at the release so it never spends the promotion", async () => {
      const f = await fixture();
      const stale = await f.card(10);
      const live = await f.card(40);
      await f.setCard(stale.interactionId, "expired");
      await f.finishEngineer();
      const result = await services().releaseIssueExecution({ companyId: f.companyId, runId: f.engineerRunId, now: new Date() });

      expect(result.outcome.kind).toBe("promoted");
      const runs = await f.coordinatorRuns();
      expect(runs).toHaveLength(1);
      expect(boundTo(runs[0]!, f.issueId, live.interactionId)).toBe(true);
      const retired = await f.wake(stale.wakeId);
      expect(retired.status).toBe("cancelled");
      expect(retired.runId).toBeNull();
      expect(retired.error).toContain("interaction_no_longer_pending");
    });

    it("claims the live card after two stale cards (three-card sequence)", async () => {
      const f = await fixture();
      const first = await f.card(10);
      const second = await f.card(20);
      const live = await f.card(40);
      await f.setCard(first.interactionId, "expired");
      await f.setCard(second.interactionId, "cancelled");
      await f.finishEngineer();
      const svc = services();
      await svc.releaseIssueExecution({ companyId: f.companyId, runId: f.engineerRunId, now: new Date() });
      const claimed = await claimCoordinatorRuns(f, svc);

      expect(claimed).toHaveLength(1);
      expect(boundTo(claimed[0]!, f.issueId, live.interactionId)).toBe(true);
    });

    it("claims the live card when the releasing Engineer run failed before provider work", async () => {
      const f = await fixture();
      const stale = await f.card(10);
      const live = await f.card(40);
      await f.setCard(stale.interactionId, "expired");
      await f.finishEngineer("failed");
      await db.update(heartbeatRuns).set({ resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } })
        .where(eq(heartbeatRuns.id, f.engineerRunId));
      const svc = services();
      await svc.releaseIssueExecution({ companyId: f.companyId, runId: f.engineerRunId, now: new Date(), suppressImmediateRecovery: true });
      const claimed = await claimCoordinatorRuns(f, svc);

      expect(claimed).toHaveLength(1);
      expect(boundTo(claimed[0]!, f.issueId, live.interactionId)).toBe(true);
    });
  });

  describe("card that leaves pending after its wake was promoted (dispatch gate)", () => {
    it("re-drains after the gate cancels the stale card's run, so the live card's addressee is claimed", async () => {
      const f = await fixture();
      const stale = await f.card(10);
      const live = await f.card(40);
      await f.finishEngineer();
      const svc = services();
      // Both cards are pending at the release: the oldest wake is promoted.
      await svc.releaseIssueExecution({ companyId: f.companyId, runId: f.engineerRunId, now: new Date() });
      const promoted = (await f.coordinatorRuns()).filter(run => run.status === "queued");
      expect(promoted).toHaveLength(1);
      expect(boundTo(promoted[0]!, f.issueId, stale.interactionId)).toBe(true);
      // The card expires between promotion and claim, as card 16881bc2 did.
      await f.setCard(stale.interactionId, "expired");
      const claimed = await claimCoordinatorRuns(f, svc);

      const [cancelled] = (await f.coordinatorRuns()).filter(run => run.id === promoted[0]!.id);
      expect(cancelled!.status).toBe("cancelled");
      expect(claimed).toHaveLength(1);
      expect(boundTo(claimed[0]!, f.issueId, live.interactionId)).toBe(true);
      expect((await f.wake(live.wakeId)).status).not.toBe("deferred_issue_execution");
    });

    it("cancels the stale card's run with a typed reason and no new-owner claim", async () => {
      const f = await fixture();
      const stale = await f.card(10);
      await f.finishEngineer();
      const svc = services();
      await svc.releaseIssueExecution({ companyId: f.companyId, runId: f.engineerRunId, now: new Date() });
      const [promoted] = (await f.coordinatorRuns()).filter(run => run.status === "queued");
      await f.setCard(stale.interactionId, "expired");
      expect(await svc.queue.claimQueuedRun(promoted!, undefined, [])).toBeNull();

      const [cancelled] = (await f.coordinatorRuns()).filter(run => run.id === promoted!.id);
      expect(cancelled).toMatchObject({ status: "cancelled", errorCode: "interaction_no_longer_pending" });
      expect(cancelled!.error).not.toMatch(/new owner/i);
      expect(cancelled!.error).not.toMatch(/assignee changed/i);
    });

    it("keeps the live card claimable across a restart between the gate cancellation and the claim", async () => {
      const f = await fixture();
      const stale = await f.card(10);
      const live = await f.card(40);
      await f.finishEngineer();
      await services().releaseIssueExecution({ companyId: f.companyId, runId: f.engineerRunId, now: new Date() });
      await f.setCard(stale.interactionId, "expired");
      const [promoted] = (await f.coordinatorRuns()).filter(run => run.status === "queued");
      // First process: the gate cancels and re-drains, then the process stops.
      expect(await services().queue.claimQueuedRun(promoted!, undefined, [])).toBeNull();
      // A fresh process claims whatever the persisted queue now holds.
      const claimed = await claimCoordinatorRuns(f, services());

      expect(claimed).toHaveLength(1);
      expect(boundTo(claimed[0]!, f.issueId, live.interactionId)).toBe(true);
    });
  });

  describe("negative controls", () => {
    it("promotes and claims a single pending card normally", async () => {
      const f = await fixture();
      const live = await f.card(10);
      await f.finishEngineer();
      const svc = services();
      await svc.releaseIssueExecution({ companyId: f.companyId, runId: f.engineerRunId, now: new Date() });
      const claimed = await claimCoordinatorRuns(f, svc);
      expect(claimed).toHaveLength(1);
      expect(boundTo(claimed[0]!, f.issueId, live.interactionId)).toBe(true);
    });

    it("leaves the live card deferred while another run holds the task execution", async () => {
      const f = await fixture();
      const stale = await f.card(10);
      const live = await f.card(40);
      await f.finishEngineer();
      const svc = services();
      await svc.releaseIssueExecution({ companyId: f.companyId, runId: f.engineerRunId, now: new Date() });
      const [promoted] = (await f.coordinatorRuns()).filter(run => run.status === "queued");
      await f.setCard(stale.interactionId, "expired");
      // The Engineer starts a new execution before the stale run is claimed.
      const nextEngineerRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: nextEngineerRunId, companyId: f.companyId, agentId: f.engineerId, invocationSource: "automation",
        status: "running", runtimeMode: "legacy", startedAt: new Date(), contextSnapshot: { issueId: f.issueId },
      });
      await db.update(issues).set({ executionRunId: nextEngineerRunId }).where(eq(issues.id, f.issueId));
      expect(await svc.queue.claimQueuedRun(promoted!, undefined, [])).toBeNull();

      expect((await f.wake(live.wakeId)).status).toBe("deferred_issue_execution");
      expect((await f.issue()).executionRunId).toBe(nextEngineerRunId);
      expect((await f.coordinatorRuns()).filter(run => run.status === "queued")).toEqual([]);
    });

    it("still cancels a genuinely reassigned owner's run as issue_assignee_changed and does not wake it again", async () => {
      const f = await fixture();
      const formerOwnerRunId = randomUUID();
      await f.finishEngineer();
      await db.update(issues).set({ executionRunId: null, status: "in_progress" }).where(eq(issues.id, f.issueId));
      await db.insert(heartbeatRuns).values({
        id: formerOwnerRunId, companyId: f.companyId, agentId: f.engineerId, invocationSource: "automation",
        status: "queued", runtimeMode: "legacy", contextSnapshot: { issueId: f.issueId, wakeReason: "issue_assigned" },
      });
      await db.update(issues).set({ assigneeAgentId: f.coordinatorId }).where(eq(issues.id, f.issueId));
      const [queued] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, formerOwnerRunId));
      expect(await services().queue.claimQueuedRun(queued!, undefined, [])).toBeNull();

      const [cancelled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, formerOwnerRunId));
      expect(cancelled).toMatchObject({ status: "cancelled", errorCode: "issue_assignee_changed" });
      const engineerRuns = await db.select().from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.engineerId)));
      expect(engineerRuns.filter(run => run.status === "queued" || run.status === "running")).toEqual([]);
    });

    it("never projects the source to blocked or opens recovery when an assignee's never-started native run is cancelled at the gate", async () => {
      const f = await fixture();
      await f.finishEngineer();
      await db.update(issues).set({ executionRunId: null, status: "done" }).where(eq(issues.id, f.issueId));
      const nativeRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: nativeRunId, companyId: f.companyId, agentId: f.engineerId, invocationSource: "automation",
        status: "queued", runtimeMode: "native", contextSnapshot: { issueId: f.issueId, wakeReason: "issue_continuation_needed" },
      });
      await db.update(issues).set({ executionRunId: nativeRunId }).where(eq(issues.id, f.issueId));
      const [queued] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, nativeRunId));
      expect(await services().queue.claimQueuedRun(queued!, undefined, [])).toBeNull();

      const [cancelled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, nativeRunId));
      expect(cancelled).toMatchObject({ status: "cancelled", errorCode: "issue_terminal_status" });
      expect(await f.issue()).toMatchObject({ status: "done", executionRunId: null });
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toEqual([]);
      const blockedWrites = await db.select().from(activityLog).where(eq(activityLog.entityId, f.issueId));
      expect(blockedWrites.filter(row => (row.details as Record<string, unknown> | null)?.status === "blocked")).toEqual([]);
    });

    it("keeps the live card deferred while the releasing run's failed attempt still needs reconciliation", async () => {
      const f = await fixture();
      const stale = await f.card(10);
      const live = await f.card(40);
      await f.setCard(stale.interactionId, "expired");
      // No evidence that provider work never started: effects are unknown.
      await f.finishEngineer("failed");
      await services().releaseIssueExecution({ companyId: f.companyId, runId: f.engineerRunId, now: new Date(), suppressImmediateRecovery: true });

      expect((await f.wake(live.wakeId)).status).toBe("deferred_issue_execution");
      expect(await f.coordinatorRuns()).toEqual([]);
    });

    it("keeps a same-run retry with an earlier started attempt held after a gate cancellation", async () => {
      const f = await fixture();
      const stale = await f.card(10);
      const live = await f.card(40);
      await f.finishEngineer();
      const svc = services();
      await svc.releaseIssueExecution({ companyId: f.companyId, runId: f.engineerRunId, now: new Date() });
      const [promoted] = (await f.coordinatorRuns()).filter(run => run.status === "queued");
      // The same run row already started once: its earlier attempt's effects are unknown.
      await db.update(heartbeatRuns).set({ startedAt: new Date(Date.now() - 60_000) }).where(eq(heartbeatRuns.id, promoted!.id));
      await f.setCard(stale.interactionId, "expired");
      const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, promoted!.id));
      expect(await svc.queue.claimQueuedRun(retry!, undefined, [])).toBeNull();

      expect((await f.wake(live.wakeId)).status).toBe("deferred_issue_execution");
      expect((await f.coordinatorRuns()).filter(run => run.status === "queued" || run.status === "running")).toEqual([]);
    });

    it("does not retire the deferred wake of a card that is still pending", async () => {
      const f = await fixture();
      const first = await f.card(10);
      const second = await f.card(40);
      await f.finishEngineer();
      await services().releaseIssueExecution({ companyId: f.companyId, runId: f.engineerRunId, now: new Date() });
      // Only the oldest live wake is promoted; the other live card stays queued behind it.
      const runs = await f.coordinatorRuns();
      expect(runs).toHaveLength(1);
      expect(boundTo(runs[0]!, f.issueId, first.interactionId)).toBe(true);
      expect((await f.wake(second.wakeId)).status).toBe("deferred_issue_execution");
    });

    it("does not retire a resolved card's own continuation wake for the assignee", async () => {
      const f = await fixture();
      const accepted = await f.card(10);
      // Remove the card's creation wake: this case is only about the resolution path.
      await db.update(agentWakeupRequests).set({ status: "cancelled" }).where(eq(agentWakeupRequests.id, accepted.wakeId));
      await f.setCard(accepted.interactionId, "accepted");
      const continuationWakeId = randomUUID();
      await db.insert(agentWakeupRequests).values({
        id: continuationWakeId, companyId: f.companyId, agentId: f.engineerId, source: "automation", reason: "issue_commented",
        status: "deferred_issue_execution", requestedByActorType: "agent", requestedByActorId: f.coordinatorId,
        payload: { issueId: f.issueId, interactionId: accepted.interactionId, mutation: "interaction",
          _paperclipWakeContext: {
            issueId: f.issueId, interactionId: accepted.interactionId, interactionKind: "request_confirmation",
            interactionStatus: "accepted", mutation: "interaction", wakeReason: "issue_commented", source: "issue.interaction.accept",
          } },
        requestedAt: at(f.t0, 30), createdAt: at(f.t0, 30), updatedAt: at(f.t0, 30),
      });
      await f.finishEngineer();
      await services().releaseIssueExecution({ companyId: f.companyId, runId: f.engineerRunId, now: new Date() });
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, continuationWakeId));
      expect(wake!.status).not.toBe("cancelled");
      expect(wake!.error ?? "").not.toContain("interaction_no_longer_pending");
    });

    it("leaves an addressed-looking wake with a malformed interaction id to its normal path", async () => {
      const f = await fixture();
      const malformedWakeId = randomUUID();
      await db.insert(agentWakeupRequests).values({
        id: malformedWakeId, companyId: f.companyId, agentId: f.coordinatorId, source: "automation", triggerDetail: "system",
        reason: "interaction_pending", status: "deferred_issue_execution", requestedByActorType: "agent", requestedByActorId: f.engineerId,
        payload: { issueId: f.issueId, interactionId: "not-a-uuid", mutation: "interaction",
          _paperclipWakeContext: {
            issueId: f.issueId, interactionId: "not-a-uuid", interactionKind: "request_confirmation",
            wakeReason: "interaction_pending", source: "issue.interaction.created",
          } },
        requestedAt: at(f.t0, 5), createdAt: at(f.t0, 5), updatedAt: at(f.t0, 5),
      });
      await f.finishEngineer();
      // The release must not abort on the uuid-typed lookup; the wake keeps its turn.
      const result = await services().releaseIssueExecution({ companyId: f.companyId, runId: f.engineerRunId, now: new Date() });
      expect(result.outcome.kind).toBe("promoted");
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, malformedWakeId));
      expect(wake!.error ?? "").not.toContain("interaction_no_longer_pending");
      expect(wake!.runId).not.toBeNull();
    });

    it("does not retire an ordinary deferred wake for the assignee", async () => {
      const f = await fixture();
      // A non-interaction wake queued ahead of a stale card keeps its turn.
      const commentWakeId = randomUUID();
      await db.insert(agentWakeupRequests).values({
        id: commentWakeId, companyId: f.companyId, agentId: f.engineerId, source: "automation", reason: "issue_children_completed",
        status: "deferred_issue_execution", requestedByActorType: "system", requestedByActorId: null,
        payload: { issueId: f.issueId, _paperclipWakeContext: { issueId: f.issueId, wakeReason: "issue_children_completed" } },
        requestedAt: at(f.t0, 5), createdAt: at(f.t0, 5), updatedAt: at(f.t0, 5),
      });
      const stale = await f.card(10);
      await f.setCard(stale.interactionId, "expired");
      await f.finishEngineer();
      await services().releaseIssueExecution({ companyId: f.companyId, runId: f.engineerRunId, now: new Date() });
      const [promotedWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, commentWakeId));
      expect(promotedWake!.status).not.toBe("cancelled");
      expect(promotedWake!.runId).not.toBeNull();
    });
  });
});
