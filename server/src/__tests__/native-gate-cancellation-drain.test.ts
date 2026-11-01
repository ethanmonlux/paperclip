import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
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

// FAC-760 STA-22 round 11, finding R8: the dispatch gate commits a stale
// addressed run's cancellation (and clears the issue lock) in its own
// transaction, and only then re-drains the deferred queue in a second one. A
// process loss or failed release between the two strands the live addressed
// wake, and the restart sweep only revisits wakes for the task's assignee, so a
// non-assignee addressee (the Coordinator) is never woken. These cases drive
// the real claim gate, the real wake-queue release and the real restart sweep
// against Postgres. A second `services()` instance models a server restart.
// No provider adapter runs.

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping gate cancellation drain tests on this host: ${support.reason ?? "unsupported environment"}`);
}

type Run = typeof heartbeatRuns.$inferSelect;

type ServiceOptions = {
  /** The post-commit drain after a gate cancellation never runs: the process is lost first. */
  loseGateDrain?: boolean;
  /** The post-commit drain's transaction fails once and rolls back. */
  failGateDrainTransactionOnce?: boolean;
  /** The release commits but its caller never sees the response. */
  loseReleaseResponse?: boolean;
};

describeEmbedded("native gate cancellation drain intent (R8)", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-gate-cancellation-drain-");
    db = createDb(temporary.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  const at = (base: Date, seconds: number) => new Date(base.getTime() + seconds * 1000);

  /** One process instance: the real wake-queue release, claim gate and restart sweep. */
  function services(options: ServiceOptions = {}) {
    let failNextResponsibleUser = options.failGateDrainTransactionOnce === true;
    const releaseIssueExecution = createReleaseIssueExecution({
      issueLock: createPostgresWakeQueueAdapter(db, {
        resolveResponsibleUserId: async () => {
          if (failNextResponsibleUser) {
            failNextResponsibleUser = false;
            return null; // the drain throws responsible_user_unresolved inside its transaction
          }
          return "responsible-user";
        },
        getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
        resolveSessionBeforeForWakeup: async () => null,
      }),
      recovery: { escalateStrandedAssignedIssue: async () => {}, escalateStrandedRecoveryIssueInPlace: async () => {} },
    });
    const released: PostCommitEffect[] = [];
    const releaseIssueExecutionAndPromote: HeartbeatQueueDependencies["releaseIssueExecutionAndPromote"] =
      async (run, releaseOptions = {}) => {
        const undispatched = (releaseOptions as { undispatchedGateCancellation?: boolean }).undispatchedGateCancellation === true;
        if (undispatched && options.loseGateDrain) throw new Error("test: process lost before the post-commit drain");
        const result = await releaseIssueExecution({
          companyId: run.companyId, runId: run.id, now: new Date(),
          suppressImmediateRecovery: releaseOptions.suppressImmediateRecovery,
          ...(undispatched ? { undispatchedGateCancellation: true } : {}),
        });
        (releaseOptions.deferredPostCommitEffects ?? released).push(...result.postCommitEffects);
        if (options.loseReleaseResponse) throw new Error("test: release committed but its response was lost");
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
      // Upstream's claim gate also asks this; the fork does not read it.
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
      // The provider never runs in these cases; a claimed run simply stays `running`.
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
    return { releaseIssueExecution, releaseIssueExecutionAndPromote, queue };
  }

  async function fixture() {
    const companyId = randomUUID(), engineerId = randomUUID(), coordinatorId = randomUUID();
    const issueId = randomUUID(), engineerRunId = randomUUID();
    const t0 = new Date(Date.now() - 10 * 60_000);
    await db.insert(companies).values({
      id: companyId, name: "Gate drain fixture", issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
    await db.insert(heartbeatRuns).values({
      id: engineerRunId, companyId, agentId: engineerId, invocationSource: "automation", status: "running",
      runtimeMode: "legacy", startedAt: at(t0, -60), createdAt: at(t0, -60), contextSnapshot: { issueId },
    });
    await db.update(issues).set({ executionRunId: engineerRunId, executionLockedAt: at(t0, -60) }).where(eq(issues.id, issueId));

    /** An addressed routing card for the Coordinator plus its wake, deferred behind the Engineer's execution. */
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
    const run = (runId: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then(rows => rows[0]!);
    const coordinatorRuns = () => db.select().from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, coordinatorId)));
    const issue = () => db.select().from(issues).where(eq(issues.id, issueId)).then(rows => rows[0]!);

    /**
     * Two pending cards, deferred behind the Engineer. The Engineer finishes and
     * its release promotes the oldest (stale-to-be) card's wake. That card then
     * leaves pending before the Coordinator's run is claimed, as card 16881bc2 did.
     */
    async function staleFirstLiveSecond(staleStatus = "expired") {
      const stale = await card(10);
      const live = await card(40);
      await finishEngineer();
      await services().releaseIssueExecution({ companyId, runId: engineerRunId, now: new Date() });
      const [promoted] = (await coordinatorRuns()).filter(r => r.status === "queued");
      expect(promoted && boundTo(promoted, issueId, stale.interactionId)).toBe(true);
      await setCard(stale.interactionId, staleStatus);
      return { stale, live, promoted: promoted! };
    }

    return {
      companyId, engineerId, coordinatorId, issueId, engineerRunId, t0,
      card, setCard, finishEngineer, wake, run, coordinatorRuns, issue, staleFirstLiveSecond,
    };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  const boundTo = (run: Run, issueId: string, interactionId: string) => {
    const context = (run.contextSnapshot ?? {}) as Record<string, unknown>;
    return context.issueId === issueId && context.interactionId === interactionId;
  };

  /** The claim gate as the scheduler calls it; an older build lets a lost drain escape the claim. */
  async function claim(svc: ReturnType<typeof services>, run: Run) {
    return svc.queue.claimQueuedRun(run, undefined, []).catch(() => null);
  }

  /** Coordinator runs bound to `interactionId` that were not cancelled: queued, claimed or finished. */
  async function liveRunsFor(f: Fixture, interactionId: string) {
    return (await f.coordinatorRuns()).filter(r => boundTo(r, f.issueId, interactionId) && r.status !== "cancelled");
  }

  const intentOf = (run: Run) => (run.resultJson as Record<string, unknown> | null)?.gateCancellationDrain as
    Record<string, unknown> | undefined;

  describe("cancellation committed, drain lost (red-first)", () => {
    it("recovers the live addressed wake exactly once through a fresh process's restart sweep after the drain is lost", async () => {
      const f = await fixture();
      const { live, promoted } = await f.staleFirstLiveSecond();
      expect(await claim(services({ loseGateDrain: true }), promoted)).toBeNull();
      // The cancellation committed and cleared the lock; nothing drained.
      expect((await f.run(promoted.id)).status).toBe("cancelled");
      expect((await f.issue()).executionRunId).toBeNull();
      expect((await f.wake(live.wakeId)).status).toBe("deferred_issue_execution");

      await services().queue.resumeQueuedRuns();

      const liveRuns = await liveRunsFor(f, live.interactionId);
      expect(liveRuns).toHaveLength(1);
      expect(liveRuns[0]!.agentId).toBe(f.coordinatorId);
      expect((await f.wake(live.wakeId)).status).not.toBe("deferred_issue_execution");
      // The source task stays with its Engineer; the cancelled run is never retried.
      expect(await f.issue()).toMatchObject({ assigneeAgentId: f.engineerId, status: "in_review" });
      expect((await f.run(promoted.id)).status).toBe("cancelled");
    });

    it("recovers the live addressed wake after the post-commit drain transaction rolls back", async () => {
      const f = await fixture();
      const { live, promoted } = await f.staleFirstLiveSecond();
      expect(await claim(services({ failGateDrainTransactionOnce: true }), promoted)).toBeNull();
      expect((await f.wake(live.wakeId)).status).toBe("deferred_issue_execution");
      expect(await liveRunsFor(f, live.interactionId)).toEqual([]);

      await services().queue.resumeQueuedRuns();

      expect(await liveRunsFor(f, live.interactionId)).toHaveLength(1);
    });

    it("promotes at most one successor across repeated restart sweeps and a duplicate direct replay", async () => {
      const f = await fixture();
      const { live, promoted } = await f.staleFirstLiveSecond();
      await claim(services({ loseGateDrain: true }), promoted);
      await services().queue.resumeQueuedRuns();
      await services().queue.resumeQueuedRuns();
      await services().releaseIssueExecutionAndPromote(promoted, {
        suppressImmediateRecovery: true, undispatchedGateCancellation: true,
      } as Parameters<HeartbeatQueueDependencies["releaseIssueExecutionAndPromote"]>[1]);
      await services().queue.resumeQueuedRuns();

      expect(await liveRunsFor(f, live.interactionId)).toHaveLength(1);
      expect((await f.coordinatorRuns()).filter(r => r.status !== "cancelled")).toHaveLength(1);
    });
  });

  describe("intent persistence and settlement", () => {
    it("persists a pending intent with the cancellation, and settles it with the exact promoted successor", async () => {
      const f = await fixture();
      const { live, promoted } = await f.staleFirstLiveSecond();
      const lost = services({ loseGateDrain: true });
      await claim(lost, promoted);
      const pending = intentOf(await f.run(promoted.id));
      expect(pending).toMatchObject({ version: 1, state: "pending", issueId: f.issueId, providerWorkStarted: false });
      expect(pending?.deferredWakeIds).toContain(live.wakeId);

      await services().queue.resumeQueuedRuns();
      const [successor] = await liveRunsFor(f, live.interactionId);
      expect(successor).toBeDefined();
      const settled = intentOf(await f.run(promoted.id));
      expect(settled).toMatchObject({ state: "settled", outcome: "promoted", successorRunId: successor?.id, successorWakeId: live.wakeId });
    });

    it("settles the intent in the uninterrupted path and later sweeps never promote again", async () => {
      const f = await fixture();
      const { live, promoted } = await f.staleFirstLiveSecond();
      const svc = services();
      expect(await claim(svc, promoted)).toBeNull();
      const [successor] = await liveRunsFor(f, live.interactionId);
      expect(successor).toBeDefined();
      expect(intentOf(await f.run(promoted.id))).toMatchObject({ state: "settled", outcome: "promoted", successorRunId: successor?.id });

      await services().queue.resumeQueuedRuns();
      await services().queue.resumeQueuedRuns();
      expect((await f.coordinatorRuns()).filter(r => r.status !== "cancelled")).toHaveLength(1);
    });

    it("reconciles a committed promotion whose response was lost without a duplicate dispatch", async () => {
      const f = await fixture();
      const { live, promoted } = await f.staleFirstLiveSecond();
      expect(await claim(services({ loseReleaseResponse: true }), promoted)).toBeNull();
      await services().queue.resumeQueuedRuns();
      await services().queue.resumeQueuedRuns();

      expect(await liveRunsFor(f, live.interactionId)).toHaveLength(1);
      expect(intentOf(await f.run(promoted.id))).toMatchObject({ state: "settled", outcome: "promoted" });
    });

    it("keeps the committed intent pending when the drain transaction rolls back", async () => {
      const f = await fixture();
      const { promoted } = await f.staleFirstLiveSecond();
      await claim(services({ failGateDrainTransactionOnce: true }), promoted);
      expect(intentOf(await f.run(promoted.id))).toMatchObject({ state: "pending" });
    });

    it("leaves no intent and no cancellation when the gate's cancellation transaction rolls back", async () => {
      const f = await fixture();
      const { live, promoted } = await f.staleFirstLiveSecond();
      const issueBefore = await f.issue();
      // Fail the gate's own lifecycle-event insert for this run: the cancellation transaction must roll back as a whole.
      const fn = `test_fail_gate_${promoted.id.replace(/-/g, "")}`;
      await db.execute(sql.raw(`create function ${fn}() returns trigger language plpgsql as $$
        begin if new.run_id = '${promoted.id}' then raise exception 'test: gate cancellation fails'; end if; return new; end $$`));
      await db.execute(sql.raw(`create trigger ${fn} before insert on heartbeat_run_events for each row execute function ${fn}()`));
      try {
        await services().queue.claimQueuedRun(promoted, undefined, []).catch(() => null);
      } finally {
        await db.execute(sql.raw(`drop trigger ${fn} on heartbeat_run_events`));
        await db.execute(sql.raw(`drop function ${fn}()`));
      }
      const after = await f.run(promoted.id);
      expect(after.status).toBe("queued");
      expect(intentOf(after)).toBeUndefined();
      expect((await f.issue()).executionRunId).toBe(issueBefore.executionRunId);
      expect((await f.wake(live.wakeId)).status).toBe("deferred_issue_execution");
    });

    it("retires the intent without promoting when every snapshot wake has become obsolete before the sweep", async () => {
      const f = await fixture();
      const { live, promoted } = await f.staleFirstLiveSecond();
      await claim(services({ loseGateDrain: true }), promoted);
      // The live card is withdrawn during the gap.
      await f.setCard(live.interactionId, "cancelled");
      await services().queue.resumeQueuedRuns();

      expect((await f.coordinatorRuns()).filter(r => r.status !== "cancelled")).toEqual([]);
      expect((await f.wake(live.wakeId)).status).not.toBe("deferred_issue_execution");
      expect(intentOf(await f.run(promoted.id))).toMatchObject({ state: "settled", outcome: "exhausted" });
    });

    it("never drains later work once its intent settled", async () => {
      const f = await fixture();
      const { promoted } = await f.staleFirstLiveSecond();
      // The uninterrupted gate drain settles the intent; new work arrives afterwards.
      const svc = services();
      await claim(svc, promoted);
      const settled = intentOf(await f.run(promoted.id));
      expect(settled?.state).toBe("settled");
      // A later card arrives deferred, and the lock is free (as after some other holder's lost release).
      const later = await f.card(600);
      await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issueId));
      await services().releaseIssueExecutionAndPromote(promoted, {
        suppressImmediateRecovery: true, undispatchedGateCancellation: true,
      } as Parameters<HeartbeatQueueDependencies["releaseIssueExecutionAndPromote"]>[1]);
      await services().queue.resumeQueuedRuns();
      expect(await liveRunsFor(f, later.interactionId)).toEqual([]);
      expect((await f.wake(later.wakeId)).status).toBe("deferred_issue_execution");
    });

    it("promotes once under concurrent consumers of the same intent", async () => {
      const f = await fixture();
      const { live, promoted } = await f.staleFirstLiveSecond();
      await claim(services({ loseGateDrain: true }), promoted);
      const replay = () => services().releaseIssueExecutionAndPromote(promoted, {
        suppressImmediateRecovery: true, undispatchedGateCancellation: true,
      } as Parameters<HeartbeatQueueDependencies["releaseIssueExecutionAndPromote"]>[1]).catch(() => null);
      await Promise.all([replay(), replay(), services().queue.resumeQueuedRuns()]);

      expect(await liveRunsFor(f, live.interactionId)).toHaveLength(1);
    });
  });

  describe("holds and identity (negative controls)", () => {
    it("does not bypass an operator Stop recorded on the cancelled run during the gap", async () => {
      const f = await fixture();
      const { live, promoted } = await f.staleFirstLiveSecond();
      await claim(services({ loseGateDrain: true }), promoted);
      const cancelled = await f.run(promoted.id);
      await db.update(heartbeatRuns).set({
        resultJson: { ...(cancelled.resultJson ?? {}), executionCancellation: { state: "acknowledged", acknowledgedAt: new Date().toISOString() } },
      }).where(eq(heartbeatRuns.id, promoted.id));
      await services().queue.resumeQueuedRuns();

      expect(await liveRunsFor(f, live.interactionId)).toEqual([]);
      expect((await f.wake(live.wakeId)).status).toBe("deferred_issue_execution");
      expect(intentOf(await f.run(promoted.id))?.state).toBe("pending");
      expect((await f.run(promoted.id)).resultJson).toMatchObject({ executionCancellation: { state: "acknowledged" } });
    });

    it("writes no intent when a Stop cancelled the queued run before the gate", async () => {
      const f = await fixture();
      const { live, promoted } = await f.staleFirstLiveSecond();
      await db.update(heartbeatRuns).set({
        status: "cancelled", finishedAt: new Date(),
        resultJson: { executionCancellation: { state: "acknowledged", acknowledgedAt: new Date().toISOString() } },
      }).where(eq(heartbeatRuns.id, promoted.id));
      // The scheduler never claims a run that is no longer queued; the gate is not reached.
      await services().queue.resumeQueuedRuns();

      expect(intentOf(await f.run(promoted.id))).toBeUndefined();
      expect(await liveRunsFor(f, live.interactionId)).toEqual([]);
    });

    it("waits while the company is paused, then resumes once when it is active again", async () => {
      const f = await fixture();
      const { live, promoted } = await f.staleFirstLiveSecond();
      await claim(services({ loseGateDrain: true }), promoted);
      await db.update(companies).set({ status: "paused" }).where(eq(companies.id, f.companyId));
      await services().queue.resumeQueuedRuns();
      expect(await liveRunsFor(f, live.interactionId)).toEqual([]);
      expect(intentOf(await f.run(promoted.id))?.state).toBe("pending");

      await db.update(companies).set({ status: "active" }).where(eq(companies.id, f.companyId));
      await services().queue.resumeQueuedRuns();
      await services().queue.resumeQueuedRuns();
      expect(await liveRunsFor(f, live.interactionId)).toHaveLength(1);
    });

    it("defers to a new execution holder without clearing its lock, then that holder's release drains once", async () => {
      const f = await fixture();
      const { live, promoted } = await f.staleFirstLiveSecond();
      await claim(services({ loseGateDrain: true }), promoted);
      const holderId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: holderId, companyId: f.companyId, agentId: f.engineerId, invocationSource: "automation", status: "running",
        runtimeMode: "legacy", startedAt: new Date(), contextSnapshot: { issueId: f.issueId },
      });
      await db.update(issues).set({ executionRunId: holderId }).where(eq(issues.id, f.issueId));
      await services().queue.resumeQueuedRuns();

      expect((await f.issue()).executionRunId).toBe(holderId);
      expect((await f.wake(live.wakeId)).status).toBe("deferred_issue_execution");
      expect(intentOf(await f.run(promoted.id))).toMatchObject({ state: "superseded", supersededByRunId: holderId });

      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, holderId));
      await services().releaseIssueExecution({ companyId: f.companyId, runId: holderId, now: new Date() });
      await services().queue.resumeQueuedRuns();
      expect(await liveRunsFor(f, live.interactionId)).toHaveLength(1);
    });

    it("keeps a same-run retry with an earlier started attempt held, with its intent pending", async () => {
      const f = await fixture();
      const { live, promoted } = await f.staleFirstLiveSecond();
      await db.update(heartbeatRuns).set({ startedAt: new Date(Date.now() - 60_000) }).where(eq(heartbeatRuns.id, promoted.id));
      const retry = await f.run(promoted.id);
      await claim(services(), retry);
      await services().queue.resumeQueuedRuns();

      expect((await f.wake(live.wakeId)).status).toBe("deferred_issue_execution");
      expect(await liveRunsFor(f, live.interactionId)).toEqual([]);
      expect(intentOf(await f.run(promoted.id))).toMatchObject({ state: "pending", providerWorkStarted: true });
    });

    it("does not act on a malformed or foreign intent", async () => {
      const f = await fixture();
      const { live, promoted } = await f.staleFirstLiveSecond();
      await claim(services({ loseGateDrain: true }), promoted);
      const cancelled = await f.run(promoted.id);
      const intent = intentOf(cancelled);
      expect(intent).toBeDefined();
      await db.update(heartbeatRuns).set({
        resultJson: { ...(cancelled.resultJson ?? {}), gateCancellationDrain: { ...intent, issueId: randomUUID() } },
      }).where(eq(heartbeatRuns.id, promoted.id));
      await services().queue.resumeQueuedRuns();

      expect(await liveRunsFor(f, live.interactionId)).toEqual([]);
      expect((await f.wake(live.wakeId)).status).toBe("deferred_issue_execution");
      expect(intentOf(await f.run(promoted.id))?.state).toBe("invalid");
    });

    it("writes no intent when the gate does not cancel a single pending card's run", async () => {
      const f = await fixture();
      const only = await f.card(10);
      await f.finishEngineer();
      const svc = services();
      await svc.releaseIssueExecution({ companyId: f.companyId, runId: f.engineerRunId, now: new Date() });
      const [queued] = (await f.coordinatorRuns()).filter(r => r.status === "queued");
      expect(queued).toBeDefined();
      if (!queued) return;
      const claimed = await claim(svc, queued);
      expect(claimed).not.toBeNull();
      expect(intentOf(await f.run(queued.id))).toBeUndefined();
      expect(await liveRunsFor(f, only.interactionId)).toHaveLength(1);
    });
  });

  // FAC-760 STA-22 round 12, finding R9: the release read the run row once
  // without a lock, then re-read it FOR UPDATE under the issue lock but used
  // only the intent from that second read. Every admission fact (Stop, the
  // never-started exemption, the queue interrupt) and the returned snapshot
  // came from the first read, so a change committed between the two reads was
  // ignored. These cases hold the issue row lock from a separate connection so
  // the release stops after its first read, commit the change, then let it go.
  // No production hook is involved.
  describe("run row changed between the release's first read and its locked read (R9)", () => {
    /** Runs `release` with the issue row locked elsewhere; `change` commits once the release is waiting on that lock. */
    async function releaseWithChangeBetweenReads<T>(f: Fixture, release: () => Promise<T>, change: () => Promise<unknown>) {
      let releaseHolder!: () => void;
      const holderDone = new Promise<void>(resolve => { releaseHolder = resolve; });
      let holderLocked!: () => void;
      const locked = new Promise<void>(resolve => { holderLocked = resolve; });
      const holder = db.transaction(async (tx) => {
        await tx.execute(sql`select id from issues where id = ${f.issueId} for update`);
        holderLocked();
        await holderDone;
      });
      await locked;
      const releasing = release();
      try {
        await waitForIssueLockWaiter();
        await change();
      } finally {
        releaseHolder();
        await holder;
      }
      return releasing;
    }

    async function waitForIssueLockWaiter() {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const rows = await db.execute(sql`
          select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and query ilike '%from issues%for update%'`);
        const n = Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
        if (n > 0) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error("test: the release never waited on the issue lock");
    }

    const replay = (svc: ReturnType<typeof services>, run: Run) => svc.releaseIssueExecutionAndPromote(run, {
      suppressImmediateRecovery: true, undispatchedGateCancellation: true,
    } as Parameters<HeartbeatQueueDependencies["releaseIssueExecutionAndPromote"]>[1]);

    /** A lost post-commit drain leaves the cancelled run with a pending intent for a replay or sweep. */
    async function lostDrain() {
      const f = await fixture();
      const { live, promoted } = await f.staleFirstLiveSecond();
      await claim(services({ loseGateDrain: true }), promoted);
      expect(intentOf(await f.run(promoted.id))?.state).toBe("pending");
      return { f, live, promoted };
    }

    const mergeResult = (runId: string, patch: Record<string, unknown>) =>
      db.update(heartbeatRuns)
        .set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
        .where(eq(heartbeatRuns.id, runId));

    function nativeReceipt(run: Run) {
      return {
        schema: "paperclip.native-cancellation.v1", runId: run.id, companyId: run.companyId, issueId: run.nativeIssueId,
        scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(),
      };
    }
    const stopWriters: Array<[string, (run: Run) => Record<string, unknown>]> = [
      ["an acknowledged executionCancellation", () => ({ executionCancellation: { state: "acknowledged", acknowledgedAt: new Date().toISOString() } })],
      ["an acknowledged native operator Stop", run => ({ cancelledByActorType: "user", cancelledByUserId: "board-user", nativeCancellation: nativeReceipt(run) })],
      ["an acknowledged native reassignment stop", run => ({ reassignmentStopRequested: true, nativeCancellation: nativeReceipt(run) })],
    ];

    it.each(stopWriters)("does not promote when %s is committed between the reads, and keeps the intent pending", async (_label, stop) => {
      const { f, live, promoted } = await lostDrain();
      await releaseWithChangeBetweenReads(f, () => replay(services(), promoted), () => mergeResult(promoted.id, stop(promoted)));

      expect(await liveRunsFor(f, live.interactionId)).toEqual([]);
      expect((await f.wake(live.wakeId)).status).toBe("deferred_issue_execution");
      const after = await f.run(promoted.id);
      expect(after.resultJson).toMatchObject(stop(promoted).executionCancellation ? { executionCancellation: { state: "acknowledged" } } : {});
      expect(intentOf(after)?.state).toBe("pending");
    });

    it("keeps that Stop across a duplicate replay, concurrent consumers and fresh-process restart sweeps", async () => {
      const { f, live, promoted } = await lostDrain();
      const stop = { executionCancellation: { state: "acknowledged", acknowledgedAt: new Date().toISOString() } };
      await releaseWithChangeBetweenReads(f, () => replay(services(), promoted), () => mergeResult(promoted.id, stop));
      await Promise.all([replay(services(), promoted).catch(() => null), services().queue.resumeQueuedRuns()]);
      await services().queue.resumeQueuedRuns();

      expect(await liveRunsFor(f, live.interactionId)).toEqual([]);
      expect((await f.coordinatorRuns()).filter(r => r.status !== "cancelled")).toEqual([]);
      const after = await f.run(promoted.id);
      expect(after.resultJson).toMatchObject({ executionCancellation: { state: "acknowledged" } });
      expect(intentOf(after)?.state).toBe("pending");
    });

    it("decides a queue interrupt from the locked row: one withdrawn between the reads no longer overrides the Stop", async () => {
      const { f, live, promoted } = await lostDrain();
      // A Stop that was a queue interrupt for the live card's wake: on a fresh read, that queue is admitted.
      await mergeResult(promoted.id, {
        executionCancellation: { state: "acknowledged", acknowledgedAt: new Date().toISOString() },
        queuedCommentInterruptQueueId: live.wakeId,
      });
      expect((await f.run(promoted.id)).runtimeMode).not.toBe("native");
      await releaseWithChangeBetweenReads(f, () => replay(services(), promoted),
        () => mergeResult(promoted.id, { queuedCommentInterruptQueueId: null }));

      expect(await liveRunsFor(f, live.interactionId)).toEqual([]);
      expect(intentOf(await f.run(promoted.id))?.state).toBe("pending");
    });

    it("decides a queue interrupt from the locked row: one recorded between the reads admits its queue once", async () => {
      const { f, live, promoted } = await lostDrain();
      await mergeResult(promoted.id, { executionCancellation: { state: "acknowledged", acknowledgedAt: new Date().toISOString() } });
      await releaseWithChangeBetweenReads(f, () => replay(services(), promoted),
        () => mergeResult(promoted.id, { queuedCommentInterruptQueueId: live.wakeId }));

      expect(await liveRunsFor(f, live.interactionId)).toHaveLength(1);
      expect(intentOf(await f.run(promoted.id))).toMatchObject({ state: "settled", outcome: "promoted" });
    });

    it("withholds the never-started exemption when an earlier started attempt is recorded between the reads", async () => {
      const { f, live, promoted } = await lostDrain();
      await releaseWithChangeBetweenReads(f, () => replay(services(), promoted),
        () => db.update(heartbeatRuns).set({ startedAt: new Date(Date.now() - 60_000) }).where(eq(heartbeatRuns.id, promoted.id)));

      expect(await liveRunsFor(f, live.interactionId)).toEqual([]);
      expect((await f.wake(live.wakeId)).status).toBe("deferred_issue_execution");
      expect(intentOf(await f.run(promoted.id))?.state).toBe("pending");
    });

    it("holds the intent pending, with a recorded reason, when the run's task changed between the reads", async () => {
      const { f, live, promoted } = await lostDrain();
      const otherIssueId = randomUUID();
      await db.insert(issues).values({ id: otherIssueId, companyId: f.companyId, title: "Other task", status: "todo" });
      const before = await f.run(promoted.id);
      await releaseWithChangeBetweenReads(f, () => replay(services(), promoted),
        () => db.update(heartbeatRuns).set({ contextSnapshot: { ...(before.contextSnapshot ?? {}), issueId: otherIssueId } })
          .where(eq(heartbeatRuns.id, promoted.id)));

      expect(await liveRunsFor(f, live.interactionId)).toEqual([]);
      expect((await f.wake(live.wakeId)).status).toBe("deferred_issue_execution");
      expect(intentOf(await f.run(promoted.id))).toMatchObject({ state: "pending", heldReason: "run_row_changed" });
    });

    it("holds the intent pending, with a recorded reason, when the run's status changed between the reads", async () => {
      const { f, live, promoted } = await lostDrain();
      await releaseWithChangeBetweenReads(f, () => replay(services(), promoted),
        () => db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, promoted.id)));

      expect(await liveRunsFor(f, live.interactionId)).toEqual([]);
      expect((await f.wake(live.wakeId)).status).toBe("deferred_issue_execution");
      expect(intentOf(await f.run(promoted.id))).toMatchObject({ state: "pending", heldReason: "run_row_changed" });
    });

    it("hands the drain and its caller the snapshot of the locked row, not of the first read", async () => {
      const { f, promoted } = await lostDrain();
      const adapter = createPostgresWakeQueueAdapter(db, {
        resolveResponsibleUserId: async () => "responsible-user",
        getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
        resolveSessionBeforeForWakeup: async () => null,
      });
      let drained: { errorCode: string | null } | null = null;
      const result = await releaseWithChangeBetweenReads(f,
        () => adapter.withIssueExecutionLock(
          { companyId: f.companyId, runId: promoted.id, now: new Date(), undispatchedGateCancellation: true },
          async (locked) => {
            drained = { errorCode: locked.run.errorCode };
            return { outcome: { kind: "released" }, postCommitEffects: [] };
          }),
        () => db.update(heartbeatRuns).set({ errorCode: "test_changed_between_reads" }).where(eq(heartbeatRuns.id, promoted.id)));

      expect(drained).toEqual({ errorCode: "test_changed_between_reads" });
      expect(result.run).toMatchObject({ id: promoted.id, status: "cancelled", errorCode: "test_changed_between_reads" });
    });

    it("still promotes exactly one successor when nothing changes while the release waits (control)", async () => {
      const { f, live, promoted } = await lostDrain();
      await releaseWithChangeBetweenReads(f, () => replay(services(), promoted), async () => undefined);

      expect(await liveRunsFor(f, live.interactionId)).toHaveLength(1);
      expect(intentOf(await f.run(promoted.id))).toMatchObject({ state: "settled", outcome: "promoted" });
      await services().queue.resumeQueuedRuns();
      expect((await f.coordinatorRuns()).filter(r => r.status !== "cancelled")).toHaveLength(1);
    });

    it("leaves a release that is not a gate cancellation unchanged (parity control)", async () => {
      const f = await fixture();
      const first = await f.card(10);
      await f.card(40);
      await f.finishEngineer();
      await releaseWithChangeBetweenReads(f,
        () => services().releaseIssueExecution({ companyId: f.companyId, runId: f.engineerRunId, now: new Date() }),
        async () => undefined);
      const queued = (await f.coordinatorRuns()).filter(r => r.status === "queued");
      expect(queued).toHaveLength(1);
      expect(boundTo(queued[0]!, f.issueId, first.interactionId)).toBe(true);
      expect(intentOf(await f.run(f.engineerRunId))).toBeUndefined();
    });
  });

});
