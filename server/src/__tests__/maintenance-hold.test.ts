import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
  companyMemberships,
  companySkills,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  maintenanceHolds,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService, resolveHeartbeatSchedulingSuppression, stopTaskDrain } from "../services/heartbeat.ts";
import { applyMaintenanceHold, readMaintenanceHold, readTaskDrain } from "../services/task-admission.js";
import { maintenanceHoldService } from "../services/maintenance-hold.js";
import { instanceSettingsRoutes } from "../routes/instance-settings.js";
import { errorHandler } from "../middleware/error-handler.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres maintenance hold tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const ACTOR = { actorType: "user", actorId: "staple-upgrade" };

describeEmbeddedPostgres("maintenance hold (FAC-840 C1)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const detachers: Array<() => void> = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("maintenance-hold-");
    db = createDb(tempDb.connectionString);
    await db.insert(authUsers).values({ id: "responsible-user", name: "Hold fixture sponsor",
      email: "hold-sponsor@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 60_000);

  afterEach(async () => {
    for (const detach of detachers.splice(0)) detach();
    applyMaintenanceHold(null);
    stopTaskDrain();
    await heartbeatService(db).drainActiveRunExecutions();
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(maintenanceHolds);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user",
      membershipRole: "operator", status: "active" });
    return companyId;
  }

  async function seedAgentAndIssue(companyId: string, priority = "medium") {
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Hold Agent ${agentId.slice(0, 4)}`,
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Held ${priority} work`,
      status: "todo",
      priority,
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    return { agentId, issueId };
  }

  function assignmentWake(issueId: string) {
    return {
      source: "assignment" as const,
      triggerDetail: "system" as const,
      reason: "issue_assigned",
      payload: { issueId },
      // The fixture process posts no comment; skip the follow-up comment wake.
      contextSnapshot: { issueId, wakeReason: "issue_assigned", skipIssueComment: true },
      requestedByActorType: "system" as const,
      requestedByActorId: "issue_assignment",
    };
  }

  // The held run itself; a finished fixture run can add its own follow-up runs.
  async function heldRun(issueId: string) {
    const runs = await runsFor(issueId);
    return runs.find(run => (run.contextSnapshot as Record<string, unknown> | null)?.wakeReason === "issue_assigned");
  }

  async function runsFor(issueId: string) {
    return db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode,
      startedAt: heartbeatRuns.startedAt, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns).where(eq(heartbeatRuns.issueId, issueId));
  }

  it("keeps wakes queued during the hold, cancels nothing, and dispatches them after release", async () => {
    const companyId = await seedCompany();
    const { agentId, issueId } = await seedAgentAndIssue(companyId);
    const heartbeat = heartbeatService(db);
    const holds = maintenanceHoldService(db);

    const placed = await holds.place({ ...ACTOR, reason: "nightly maintenance window" });
    expect(placed.created).toBe(true);
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({ suppressed: true, reason: "task_drain" });

    await heartbeat.wakeup(agentId, assignmentWake(issueId));
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const [wake] = await db.select({ status: agentWakeupRequests.status, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests);
    expect(wake?.status).toBe("queued");
    expect(wake?.payload).not.toHaveProperty("heartbeatSkip");
    expect(await runsFor(issueId)).toEqual([expect.objectContaining({ status: "queued", startedAt: null })]);
    expect(await holds.status()).toMatchObject({ active: true, queuedRuns: 1, runningRuns: 0 });

    const released = await holds.release("upgraded");
    expect(released.wasActive).toBe(true);
    expect(readMaintenanceHold(new Date())).toBeNull();
    await holds.releaseHeldWork(heartbeat, 0);
    await heartbeat.drainActiveRunExecutions();

    expect(await heldRun(issueId)).toMatchObject({ status: "succeeded" });
    const allRuns = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
    expect(allRuns.some(run => run.status === "cancelled")).toBe(false);
    const [row] = await db.select().from(maintenanceHolds);
    expect(row).toMatchObject({ releaseReason: "upgraded" });
    expect(row?.releasedAt).toBeInstanceOf(Date);
  }, 30_000);

  it("survives a restart: a new process loads the hold before it can start queued work", async () => {
    const companyId = await seedCompany();
    const { agentId, issueId } = await seedAgentAndIssue(companyId);
    await maintenanceHoldService(db).place(ACTOR);
    await heartbeatService(db).wakeup(agentId, assignmentWake(issueId));

    // The install restart clears process memory; the record stays in the database.
    applyMaintenanceHold(null);
    expect(readTaskDrain(new Date())).toBeNull();
    const loaded = await maintenanceHoldService(db).load();
    expect(loaded).not.toBeNull();
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({ suppressed: true, reason: "task_drain" });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect(await runsFor(issueId)).toEqual([expect.objectContaining({ status: "queued", startedAt: null })]);
  }, 30_000);

  it("renews only forward and never past the total ceiling", async () => {
    const holds = maintenanceHoldService(db);
    const start = new Date(Date.now() - 60_000);
    const first = await holds.place({ ...ACTOR, drainMs: 45 * 60_000, maxMs: 90 * 60_000 }, start);
    const renewed = await holds.place({ ...ACTOR, maxMs: 10 * 60_000 }, new Date());
    expect(renewed.created).toBe(false);
    expect(renewed.row.id).toBe(first.row.id);
    expect(renewed.row.expiresAt.getTime()).toBe(first.row.expiresAt.getTime());
    expect(renewed.row.drainDeadlineAt.getTime()).toBe(first.row.drainDeadlineAt.getTime());
    const extended = await holds.place({ ...ACTOR, maxMs: 4 * 60 * 60_000 }, new Date());
    expect(extended.row.expiresAt.getTime()).toBe(start.getTime() + 4 * 60 * 60_000);
  });

  it("auto-releases at its expiry even when nobody releases it, and starts the held work", async () => {
    const companyId = await seedCompany();
    const { agentId, issueId } = await seedAgentAndIssue(companyId);
    const heartbeat = heartbeatService(db);
    const holds = maintenanceHoldService(db);
    detachers.push(holds.attach(heartbeat));
    const placed = await holds.place(ACTOR);
    await heartbeat.wakeup(agentId, assignmentWake(issueId));
    await heartbeat.drainActiveRunExecutions();
    expect(await runsFor(issueId)).toEqual([expect.objectContaining({ status: "queued" })]);

    // The managed script died; the maximum duration passes.
    const past = new Date(Date.now() - 1_000);
    await db.update(maintenanceHolds).set({ expiresAt: past }).where(eq(maintenanceHolds.id, placed.row.id));
    applyMaintenanceHold({ id: placed.row.id, startedAt: placed.row.startedAt,
      drainDeadlineAt: placed.row.drainDeadlineAt, expiresAt: past, parkedAt: null });
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({ suppressed: false, reason: null });

    await vi.waitFor(async () => {
      expect(await heldRun(issueId)).toMatchObject({ status: "succeeded" });
    }, { timeout: 15_000, interval: 100 });
    await vi.waitFor(async () => {
      const [row] = await db.select().from(maintenanceHolds);
      expect(row).toMatchObject({ releaseReason: "expired" });
    });
    await heartbeat.drainActiveRunExecutions();
  }, 30_000);

  it.each([
    { adapter: "claude_local", conversation: true },
    { adapter: "process", conversation: false },
  ])("parks a $adapter run still running at the drain deadline and keeps its continuation", async ({ adapter, conversation }) => {
    const companyId = await seedCompany();
    const { agentId, issueId } = await seedAgentAndIssue(companyId);
    // A turn that is still working when the drain deadline arrives.
    await db.update(agents).set({ adapterConfig: { command: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"] } })
      .where(eq(agents.id, agentId));
    const heartbeat = heartbeatService(db);
    const holds = maintenanceHoldService(db);
    await heartbeat.wakeup(agentId, assignmentWake(issueId));
    let runId = "";
    await vi.waitFor(async () => {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, issueId));
      expect(run).toMatchObject({ status: "running" });
      expect(run?.processPid).toBeTruthy();
      runId = run!.id;
    }, { timeout: 15_000, interval: 100 });
    if (conversation) {
      // Record the claim as the conversation adapter the live agents use (claude_local, codex_local).
      const [run] = await db.select({ profile: heartbeatRuns.runnerProfileJson }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      await db.update(heartbeatRuns).set({ runnerProfileJson: { ...(run?.profile ?? {}), adapterDispatch: { adapterType: adapter } } })
        .where(eq(heartbeatRuns.id, runId));
    }

    const placed = await holds.place({ ...ACTOR, drainMs: 0 });
    const parked = await holds.parkRunningRuns(heartbeat, {
      id: placed.row.id, startedAt: placed.row.startedAt, drainDeadlineAt: placed.row.drainDeadlineAt,
      expiresAt: placed.row.expiresAt, parkedAt: null,
    });
    await heartbeat.drainActiveRunExecutions();
    expect(parked.interrupted).toBe(1);

    const runs = await runsFor(issueId);
    expect(runs.find(run => run.id === runId)).toMatchObject({ status: "interrupted", errorCode: "maintenance_hold_parked" });
    expect(runs.some(run => run.status === "cancelled")).toBe(false);
    expect(await holds.status()).toMatchObject({ runningRuns: 0, hold: { parkedRunCount: 1 } });
    const resume = (await db.select({ payload: agentWakeupRequests.payload }).from(agentWakeupRequests))
      .find(wake => (wake.payload as Record<string, unknown> | null)?.waitFor === "maintenance_window");
    expect(resume).toBeDefined();
    const continuation = runs.find(run => run.id !== runId);
    if (!conversation) {
      // An adapter without a safe resume checkpoint keeps its existing contract: the continuation
      // is saved behind board reconciliation of the stopped run, not dropped and not replayed blind.
      expect(continuation).toBeUndefined();
      expect((resume!.payload as Record<string, unknown>).executionWait).toMatchObject({ reason: "execution_recovery" });
      return;
    }
    expect(continuation).toMatchObject({ status: "queued", startedAt: null });
    expect(continuation!.contextSnapshot).toMatchObject({ wakeReason: "maintenance_window_resume", waitFor: "maintenance_window" });
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect((await runsFor(issueId)).find(run => run.id === continuation!.id)).toMatchObject({ status: "queued" });

    await holds.release("upgraded");
    await db.update(agents).set({ adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] } })
      .where(eq(agents.id, agentId));
    await holds.releaseHeldWork(heartbeat, 0);
    await heartbeat.drainActiveRunExecutions();
    expect((await runsFor(issueId)).find(run => run.id === continuation!.id)?.status).toBe("succeeded");
  }, 30_000);

  it("releases held agents in priority order, critical first", async () => {
    const companyId = await seedCompany();
    const low = await seedAgentAndIssue(companyId, "low");
    const critical = await seedAgentAndIssue(companyId, "critical");
    const medium = await seedAgentAndIssue(companyId, "medium");
    const heartbeat = heartbeatService(db);
    const holds = maintenanceHoldService(db);
    await holds.place(ACTOR);
    for (const fixture of [low, critical, medium]) await heartbeat.wakeup(fixture.agentId, assignmentWake(fixture.issueId));
    await heartbeat.drainActiveRunExecutions();

    await holds.release("upgraded");
    await holds.releaseHeldWork(heartbeat, 0);
    await heartbeat.drainActiveRunExecutions();
    const held = await Promise.all([low, critical, medium].map(async fixture => ({ issueId: fixture.issueId,
      startedAt: (await heldRun(fixture.issueId))!.startedAt! })));
    const order = held.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime()).map(run => run.issueId);
    expect(order).toEqual([critical.issueId, medium.issueId, low.issueId]);
  }, 30_000);

  describe("routes", () => {
    function app(actor: Record<string, unknown>) {
      const server = express();
      server.use(express.json());
      server.use((req, _res, next) => { (req as any).actor = actor; next(); });
      server.use("/api", instanceSettingsRoutes(db));
      server.use(errorHandler);
      return server;
    }
    const admin = { type: "board", userId: "responsible-user", source: "session", isInstanceAdmin: true, companyIds: [] };

    it("refuses an agent key and a non-admin board member, and lets an instance admin hold and release", async () => {
      const companyId = await seedCompany();
      const agent = { type: "agent", agentId: randomUUID(), companyId, source: "agent_key", runId: randomUUID() };
      await request(app(agent)).post("/api/instance/maintenance-hold").send({}).expect(403);
      await request(app(agent)).delete("/api/instance/maintenance-hold").expect(403);
      const member = { ...admin, isInstanceAdmin: false, companyIds: [companyId], memberships: [] };
      await request(app(member)).post("/api/instance/maintenance-hold").send({}).expect(403);
      expect(readMaintenanceHold(new Date())).toBeNull();

      const placed = await request(app(admin)).post("/api/instance/maintenance-hold")
        .send({ drainMinutes: 45, maxMinutes: 90, reason: "nightly maintenance window" }).expect(201);
      expect(placed.body).toMatchObject({ created: true, active: true, hold: { reason: "nightly maintenance window" } });
      expect(Date.parse(placed.body.hold.expiresAt) - Date.parse(placed.body.hold.startedAt)).toBe(90 * 60_000);
      await request(app(admin)).post("/api/instance/maintenance-hold").send({ maxMinutes: 999 }).expect(400);
      // The generic operator drain cannot lift the maintenance hold.
      await request(app(admin)).delete("/api/instance/task-drain").expect(200);
      expect(readMaintenanceHold(new Date())).not.toBeNull();

      const released = await request(app(admin)).delete("/api/instance/maintenance-hold?reason=upgraded").expect(200);
      expect(released.body).toMatchObject({ wasActive: true, active: false });
      const actions = await db.select({ action: activityLog.action }).from(activityLog);
      expect(actions.map(row => row.action)).toEqual(expect.arrayContaining([
        "instance.maintenance_hold.placed", "instance.maintenance_hold.released"]));
    }, 30_000);
  });
});
