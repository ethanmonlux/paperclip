import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  chatPublications,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { founderNotificationRoutes } from "../routes/founder-notifications.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { founderNotificationAttentionSource } from "../services/founder-notification-attention.js";
import { founderNotificationService } from "../services/founder-notifications.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { founderNotificationFixtures, type FounderNotificationFixture } from "./helpers/founder-notification-fixture.js";

// Only the agent adapter is faked. The founder sweep, the acknowledgement and
// interaction-resolution routes, the durable wake requests, dependency
// admission, the run queue and run execution bookkeeping are all real. No
// provider is contacted; the real-phone and installed-runtime canary stays
// with the activation gate.
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_ctx: unknown) => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Founder continuation test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

describeEmbeddedPostgres("founder notification continuation through real admission", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousPublicUrl = process.env.PAPERCLIP_PUBLIC_URL;
  const { seed, enabledRoute, founderPublications, episodes } = founderNotificationFixtures(() => db);

  beforeAll(async () => {
    process.env.PAPERCLIP_PUBLIC_URL = "https://paperclip.example";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-founder-continuation-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    // Let every run this test started finish before the next one seeds.
    await waitForCondition(async () => {
      const rows = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      return rows.every((run) => run.status !== "queued" && run.status !== "running");
    });
    const heartbeat = heartbeatService(db);
    const runIds = (await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).map((run) => run.id);
    await Promise.all(runIds.map((runId) => heartbeat.waitForRunExecutionDrain(runId)));
    runningProcesses.clear();
    mockAdapterExecute.mockClear();
  });

  afterAll(async () => {
    if (previousPublicUrl === undefined) delete process.env.PAPERCLIP_PUBLIC_URL;
    else process.env.PAPERCLIP_PUBLIC_URL = previousPublicUrl;
    await tempDb?.cleanup();
  });

  /**
   * A founder decision card on the fixture task, assigned to the fixture
   * agent, delivered to the founder's phone (recorded as published), plus a
   * board app mounting the real founder and issue routes.
   */
  async function founderDecision(fixture: FounderNotificationFixture) {
    await db
      .update(agents)
      .set({
        status: "active",
        // A credential-free adapter type, so preparation reaches the faked
        // execute instead of failing a provider credential preflight.
        adapterType: "process",
        adapterConfig: { command: "true" },
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      })
      .where(eq(agents.companyId, fixture.companyId));
    await db.update(issues).set({ status: "in_progress", blockedTransitionAt: null }).where(eq(issues.id, fixture.task.id));
    await enabledRoute(fixture);
    const card = await issueThreadInteractionService(db).create(
      { id: fixture.task.id, companyId: fixture.companyId },
      {
        kind: "request_confirmation",
        continuationPolicy: "wake_assignee",
        title: "Canary go/no-go",
        payload: { version: 1, prompt: "Proceed with the phone canary?" },
      },
      { agentId: fixture.agentId },
    );
    const source = founderNotificationAttentionSource(db);
    const sweeper = () =>
      founderNotificationService(db, {
        listAttention: async (companyId, userId, actor) => (companyId === fixture.companyId ? source(companyId, userId, actor) : []),
      });
    await sweeper().sweep();
    const [notification] = (await founderPublications(fixture.companyId)).filter((row) => row.issueId === fixture.task.id);
    expect(notification).toBeDefined();
    await db.update(chatPublications).set({ state: "published", providerMessageId: "m-1" }).where(eq(chatPublications.id, notification!.id));
    const episode = (await episodes(fixture.companyId)).find((row) => row.payload.dedupKey === `interaction:${card.id}`)!;
    expect(episode).toMatchObject({ status: "open" });

    const founder = {
      type: "board",
      source: "session",
      userId: fixture.founderUserId,
      companyIds: [fixture.companyId],
      memberships: [{ companyId: fixture.companyId, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: false,
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = founder;
      next();
    });
    app.use("/api", founderNotificationRoutes(db, sweeper()));
    app.use("/api", issueRoutes(db, {} as never, {}));
    app.use(errorHandler);
    return {
      card,
      episode,
      sweep: () => sweeper().sweep(),
      acknowledge: () =>
        request(app).post(`/api/companies/${fixture.companyId}/founder-notifications/episodes/${episode.id}/acknowledge`),
      answer: () => request(app).post(`/api/issues/${fixture.task.id}/interactions/${card.id}/accept`).send({}),
    };
  }

  const runsFor = (companyId: string) =>
    db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId))
      .orderBy(heartbeatRuns.createdAt);
  const wakeRequestsFor = (agentId: string, issueId: string) =>
    db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`));
  const issueOf = (run: { contextSnapshot: unknown }) => (run.contextSnapshot as Record<string, unknown> | null)?.issueId;
  const settled = (companyId: string) =>
    waitForCondition(async () => (await runsFor(companyId)).every((run) => run.status !== "queued" && run.status !== "running"));
  const adapterIssueIds = () =>
    mockAdapterExecute.mock.calls.map(([ctx]) => ((ctx as { context?: Record<string, unknown> }).context ?? {}).issueId);

  it("runs the original task for its assignee exactly once when the founder answers, never on acknowledgement", async () => {
    const fixture = await seed();
    const decision = await founderDecision(fixture);

    // Acknowledgement alone keeps the wait: no wake request and no run.
    await decision.acknowledge().expect(200);
    await decision.sweep();
    expect(await wakeRequestsFor(fixture.agentId, fixture.task.id)).toEqual([]);
    expect(await runsFor(fixture.companyId)).toEqual([]);

    // The founder's answer through the real resolution route is consumed
    // into one run bound to the original task and its assignee.
    await decision.answer().expect(200);
    expect(await waitForCondition(async () => (await runsFor(fixture.companyId)).some((run) => run.status === "succeeded"))).toBe(true);
    expect(await settled(fixture.companyId)).toBe(true);
    const runs = await runsFor(fixture.companyId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ agentId: fixture.agentId, status: "succeeded" });
    expect(runs[0]!.contextSnapshot).toMatchObject({
      issueId: fixture.task.id,
      interactionId: decision.card.id,
      interactionStatus: "accepted",
      wakeReason: "issue_commented",
    });
    expect(adapterIssueIds()).toEqual([fixture.task.id]);
    const wakes = await wakeRequestsFor(fixture.agentId, fixture.task.id);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ reason: "issue_commented", runId: runs[0]!.id });
    // Nothing ran for the founder's chat task or any other issue.
    expect(runs.filter((run) => issueOf(run) !== fixture.task.id)).toEqual([]);

    // A repeated answer and further sweeps start nothing more.
    const repeated = await decision.answer().expect(409);
    expect(repeated.body).toMatchObject({ code: "interaction_already_resolved" });
    await decision.sweep();
    await decision.sweep();
    expect(await settled(fixture.companyId)).toBe(true);
    expect(await runsFor(fixture.companyId)).toHaveLength(1);
    expect(await wakeRequestsFor(fixture.agentId, fixture.task.id)).toHaveLength(1);
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    const [episodeAfter] = (await episodes(fixture.companyId)).filter((row) => row.id === decision.episode.id);
    expect(episodeAfter).toMatchObject({ status: "resolved", payload: { resolutionReason: "item_cleared" } });
  }, 60_000);

  it("keeps an answer queued behind a busy assignee and runs it exactly once after a restart", async () => {
    const fixture = await seed();
    const decision = await founderDecision(fixture);
    const [busyIssue] = await db
      .insert(issues)
      .values({ companyId: fixture.companyId, title: "Unrelated busy work", status: "todo", assigneeAgentId: fixture.agentId })
      .returning();
    let finishBusy!: () => void;
    const busyFinished = new Promise<void>((resolve) => {
      finishBusy = resolve;
    });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await busyFinished;
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Busy work done.", provider: "test", model: "test-model" };
    });
    try {
      const busy = await heartbeatService(db).wakeup(fixture.agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: busyIssue!.id },
        contextSnapshot: { issueId: busyIssue!.id, wakeReason: "issue_assigned" },
      });
      expect(busy).not.toBeNull();
      expect(await waitForCondition(async () => mockAdapterExecute.mock.calls.length === 1, 30_000)).toBe(true);

      // The answer arrives while the assignee is at maxConcurrentRuns.
      await decision.answer().expect(200);
      const taskRuns = async () => (await runsFor(fixture.companyId)).filter((run) => issueOf(run) === fixture.task.id);
      expect(await waitForCondition(async () => (await taskRuns()).length === 1)).toBe(true);
      expect((await taskRuns())[0]).toMatchObject({ status: "queued", agentId: fixture.agentId });

      // The process dies: the in-flight busy run is lost and recorded as
      // failed, and only durable state survives. A fresh service resumes the
      // queued continuation.
      await db
        .update(heartbeatRuns)
        .set({ status: "failed", finishedAt: new Date(), error: "process lost (test restart)" })
        .where(eq(heartbeatRuns.id, busy!.id));
      const restarted = heartbeatService(db);
      await restarted.resumeQueuedRuns();
      await restarted.resumeQueuedRuns();
      expect(await waitForCondition(async () => (await taskRuns())[0]?.status === "succeeded")).toBe(true);
    } finally {
      // The lost run's adapter call returns late; it must not add a run.
      finishBusy();
    }
    expect(await settled(fixture.companyId)).toBe(true);
    await heartbeatService(db).resumeQueuedRuns();
    await decision.sweep();
    expect(await settled(fixture.companyId)).toBe(true);
    const runs = (await runsFor(fixture.companyId)).filter((run) => issueOf(run) === fixture.task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ agentId: fixture.agentId, status: "succeeded" });
    expect(runs[0]!.contextSnapshot).toMatchObject({ interactionId: decision.card.id, interactionStatus: "accepted" });
    expect(adapterIssueIds().filter((id) => id === fixture.task.id)).toHaveLength(1);
  }, 60_000);

  it("does not let an answer bypass an unrelated dependency hold, and runs once when the hold clears", async () => {
    const fixture = await seed();
    const decision = await founderDecision(fixture);
    // A protected hold: the task is also blocked by unrelated open work.
    const [holder] = await db
      .insert(issues)
      .values({ companyId: fixture.companyId, title: "Unrelated prerequisite", status: "in_progress", assigneeAgentId: fixture.reviewerId })
      .returning();
    await db.insert(issueRelations).values({ companyId: fixture.companyId, issueId: holder!.id, relatedIssueId: fixture.task.id, type: "blocks" });
    await db.update(issues).set({ status: "blocked", blockedTransitionAt: new Date() }).where(eq(issues.id, fixture.task.id));

    await decision.acknowledge().expect(200);
    expect(await wakeRequestsFor(fixture.agentId, fixture.task.id)).toEqual([]);

    // The answer is recorded but held: no run for the task while it waits.
    await decision.answer().expect(200);
    expect(
      await waitForCondition(async () => (await wakeRequestsFor(fixture.agentId, fixture.task.id)).length > 0),
    ).toBe(true);
    await decision.sweep();
    expect(await settled(fixture.companyId)).toBe(true);
    const held = await wakeRequestsFor(fixture.agentId, fixture.task.id);
    expect(held.map((wake) => [wake.reason, wake.status, wake.runId])).toEqual([["issue_dependencies_blocked", "skipped", null]]);
    expect((await runsFor(fixture.companyId)).filter((run) => issueOf(run) === fixture.task.id)).toEqual([]);
    expect(adapterIssueIds()).not.toContain(fixture.task.id);
    const relations = await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId, fixture.task.id));
    expect(relations.map((row) => row.issueId)).toEqual([holder!.id]);

    // The hold clears through native dependency reconciliation: exactly one
    // run for the original task and assignee, and no more on repetition.
    await db.update(issues).set({ status: "done", completedAt: new Date(), updatedAt: new Date() }).where(eq(issues.id, holder!.id));
    const heartbeat = heartbeatService(db);
    expect(await heartbeat.reconcileResolvedDependencyWakes({ companyId: fixture.companyId })).toMatchObject({ healed: 1 });
    const taskRuns = async () => (await runsFor(fixture.companyId)).filter((run) => issueOf(run) === fixture.task.id);
    expect(await waitForCondition(async () => (await taskRuns()).some((run) => run.status === "succeeded"))).toBe(true);
    await heartbeat.reconcileResolvedDependencyWakes({ companyId: fixture.companyId });
    await heartbeatService(db).resumeQueuedRuns();
    await decision.sweep();
    expect(await settled(fixture.companyId)).toBe(true);
    const runs = await taskRuns();
    expect(runs).toHaveLength(1);
    // The held answer is not replayed separately: the one run is the native
    // blockers-resolved continuation of the same task, whose thread already
    // carries the accepted decision.
    expect(runs[0]).toMatchObject({ agentId: fixture.agentId, status: "succeeded" });
    expect(runs[0]!.contextSnapshot).toMatchObject({ issueId: fixture.task.id, wakeReason: "issue_blockers_resolved" });
    expect(adapterIssueIds().filter((id) => id === fixture.task.id)).toHaveLength(1);
  }, 60_000);
});
