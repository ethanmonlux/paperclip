import type { Db } from "@paperclipai/db";
import { activityLog, agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issues } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createHeartbeatQueueTestDependencies } from "../../__tests__/helpers/heartbeat-queue.js";
import { createHeartbeatQueue } from "./queue.js";
import {
  decideUrgentBurst,
  queuedRunRank,
  readAvailableMemoryBytes,
  URGENT_BURST_HEADROOM_BYTES,
  URGENT_BURST_RUN_MEMORY_BYTES,
} from "./urgent-lane.js";

const GIB = 1024 ** 3;

describe("urgent lane decisions", () => {
  it("replays STA-165: a critical todo fix ranks ahead of three queued in-progress runs", () => {
    const queued = [
      { id: "in-progress-1", hasIssue: true, dependencyReady: true, issueStatus: "in_progress", issuePriority: "high" },
      { id: "in-progress-2", hasIssue: true, dependencyReady: true, issueStatus: "in_progress", issuePriority: "medium" },
      { id: "in-progress-3", hasIssue: true, dependencyReady: true, issueStatus: "in_progress", issuePriority: "high" },
      { id: "red-main-fix", hasIssue: true, dependencyReady: true, issueStatus: "todo", issuePriority: "critical" },
    ];
    const order = [...queued].sort((left, right) => {
      const [a, b] = [queuedRunRank(left), queuedRunRank(right)];
      return a[0] - b[0] || a[1] - b[1];
    }).map(run => run.id);
    expect(order[0]).toBe("red-main-fix");
  });

  it("keeps a blocked critical issue behind ready work", () => {
    expect(queuedRunRank({ hasIssue: true, dependencyReady: false, issueStatus: "todo", issuePriority: "critical" })[0])
      .toBeGreaterThan(queuedRunRank({ hasIssue: true, dependencyReady: true, issueStatus: "todo", issuePriority: "low" })[0]);
  });

  it("bursts only for a critical issue, once, with a full run cap plus headroom free", () => {
    const enough = URGENT_BURST_RUN_MEMORY_BYTES + URGENT_BURST_HEADROOM_BYTES;
    const base = { issuePriority: "critical", maxConcurrentRuns: 2, runningCount: 2, runningBurstCount: 0, availableMemoryBytes: enough };
    expect(decideUrgentBurst(base)).toEqual({ grant: true, effectiveMaxConcurrentRuns: 3, availableMemoryBytes: enough });
    expect(decideUrgentBurst({ ...base, issuePriority: "high" })).toMatchObject({ grant: false, reason: "not_urgent" });
    expect(decideUrgentBurst({ ...base, runningCount: 1 })).toMatchObject({ grant: false, reason: "slot_available" });
    expect(decideUrgentBurst({ ...base, runningBurstCount: 1, runningCount: 3 })).toMatchObject({ grant: false, reason: "burst_in_use" });
    expect(decideUrgentBurst({ ...base, availableMemoryBytes: enough - 1 })).toMatchObject({ grant: false, reason: "insufficient_memory" });
  });

  it("reads MemAvailable, not MemFree", () => {
    expect(readAvailableMemoryBytes(() => "MemTotal:       16000000 kB\nMemFree:          100000 kB\nMemAvailable:    6000000 kB\n"))
      .toBe(6000000 * 1024);
  });
});

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_URGENT_LANE_TEST_DATABASE_URL");
const support = external ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping urgent lane database tests: ${support.reason}`);

describe.skipIf(!support.supported)("urgent lane dispatch", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("paperclip-urgent-lane");
    db = createDb(external ?? database!.connectionString, { maxConnections: 4 });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });
  beforeEach(async () => {
    await db.execute(sql`truncate table companies restart identity cascade`);
  });

  async function fixture(maxConcurrentRuns: number, freeMemoryBytes: number) {
    await db.insert(authUsers).values({ id: "urgent-owner", name: "Owner", email: "urgent-owner@paperclip.test", createdAt: new Date(), updatedAt: new Date() })
      .onConflictDoNothing();
    const [company] = await db.insert(companies).values({ name: "Urgent lane", issuePrefix: "UL", defaultResponsibleUserId: "urgent-owner" }).returning();
    await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: "urgent-owner", status: "active", membershipRole: "member" });
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Workflow Repair Engineer", status: "idle",
      adapterType: "process", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns } } }).returning();
    const deps = createHeartbeatQueueTestDependencies(db);
    deps.getAgent.mockResolvedValue(agent!);
    deps.readAvailableMemoryBytes = () => freeMemoryBytes;
    const queue = createHeartbeatQueue(db, deps);
    let minute = 0;
    const issueRun = async (title: string, input: { status: string; priority: string; runStatus: "queued" | "running" }) => {
      const [issue] = await db.insert(issues).values({ companyId: company!.id, title, status: input.status, priority: input.priority,
        assigneeAgentId: agent!.id, responsibleUserId: "urgent-owner" }).returning();
      minute += 1;
      const [run] = await db.insert(heartbeatRuns).values({ companyId: company!.id, agentId: agent!.id, status: input.runStatus,
        invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId: issue!.id },
        createdAt: new Date(Date.UTC(2026, 10, 9, 2, minute)), ...(input.runStatus === "running" ? { startedAt: new Date() } : {}) }).returning();
      if (input.runStatus === "running") await db.update(issues).set({ executionRunId: run!.id }).where(eq(issues.id, issue!.id));
      return { issue: issue!, run: run! };
    };
    const statusOf = async (runId: string) => (await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]?.status;
    const urgentLog = async () => (await db.select({ action: activityLog.action, entityId: activityLog.entityId, runId: activityLog.runId, details: activityLog.details })
      .from(activityLog).where(and(eq(activityLog.agentId, agent!.id), sql`${activityLog.action} like 'heartbeat.urgent_burst_%'`))
      .orderBy(activityLog.createdAt));
    return { agent: agent!, deps, queue, issueRun, statusOf, urgentLog };
  }

  it("starts a critical todo fix before older queued in-progress work (STA-165)", async () => {
    const f = await fixture(1, 64 * GIB);
    const older = [];
    for (let index = 0; index < 3; index++) older.push(await f.issueRun(`In progress ${index}`, { status: "in_progress", priority: "high", runStatus: "queued" }));
    const fix = await f.issueRun("Fix red main", { status: "todo", priority: "critical", runStatus: "queued" });
    const claimed = await f.queue.startNextQueuedRunForAgent(f.agent.id);
    expect(claimed.map(run => run.id)).toEqual([fix.run.id]);
    for (const run of older) expect(await f.statusOf(run.run.id)).toBe("queued");
    expect(await f.urgentLog()).toEqual([]);
  });

  it("bursts one slot for the urgent run, logs it on the urgent issue, and reverts when that run ends", async () => {
    const f = await fixture(1, 8 * GIB);
    const busy = await f.issueRun("Ordinary work", { status: "in_progress", priority: "medium", runStatus: "running" });
    const waiting = await f.issueRun("Next ordinary work", { status: "todo", priority: "high", runStatus: "queued" });
    const fix = await f.issueRun("Fix red main", { status: "todo", priority: "critical", runStatus: "queued" });

    expect((await f.queue.startNextQueuedRunForAgent(f.agent.id)).map(run => run.id)).toEqual([fix.run.id]);
    expect(await f.statusOf(waiting.run.id)).toBe("queued");
    expect(await f.urgentLog()).toMatchObject([{ action: "heartbeat.urgent_burst_granted", entityId: fix.issue.id, runId: fix.run.id,
      details: { baseMaxConcurrentRuns: 1, effectiveMaxConcurrentRuns: 2 } }]);

    // Still full (1 ordinary + 1 burst): nothing else starts, and no second burst.
    expect(await f.queue.startNextQueuedRunForAgent(f.agent.id)).toEqual([]);

    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, fix.run.id));
    // The ordinary run still holds the agent's only normal slot.
    expect(await f.queue.startNextQueuedRunForAgent(f.agent.id)).toEqual([]);
    expect((await f.urgentLog()).map(entry => entry.action)).toEqual(["heartbeat.urgent_burst_granted", "heartbeat.urgent_burst_reverted"]);
    expect((await f.urgentLog())[1]).toMatchObject({ entityId: fix.issue.id, runId: fix.run.id, details: { runStatus: "succeeded", maxConcurrentRuns: 1 } });

    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busy.run.id));
    expect((await f.queue.startNextQueuedRunForAgent(f.agent.id)).map(run => run.id)).toEqual([waiting.run.id]);
    expect(await f.urgentLog()).toHaveLength(2);
  });

  it("parks the urgent run at the front of the queue when memory cannot cover a burst", async () => {
    const f = await fixture(1, 3 * GIB);
    const busy = await f.issueRun("Ordinary work", { status: "in_progress", priority: "medium", runStatus: "running" });
    const waiting = await f.issueRun("Next ordinary work", { status: "in_progress", priority: "high", runStatus: "queued" });
    const fix = await f.issueRun("Fix red main", { status: "todo", priority: "critical", runStatus: "queued" });

    expect(await f.queue.startNextQueuedRunForAgent(f.agent.id)).toEqual([]);
    expect(await f.queue.startNextQueuedRunForAgent(f.agent.id)).toEqual([]);
    const parked = await f.urgentLog();
    expect(parked).toMatchObject([{ action: "heartbeat.urgent_burst_parked", entityId: fix.issue.id, details: { reason: "insufficient_memory" } }]);

    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busy.run.id));
    expect((await f.queue.startNextQueuedRunForAgent(f.agent.id)).map(run => run.id)).toEqual([fix.run.id]);
    expect(await f.statusOf(waiting.run.id)).toBe("queued");
  });

  it("never bursts for ordinary work", async () => {
    const f = await fixture(1, 64 * GIB);
    await f.issueRun("Ordinary work", { status: "in_progress", priority: "medium", runStatus: "running" });
    await f.issueRun("High but not critical", { status: "todo", priority: "high", runStatus: "queued" });
    expect(await f.queue.startNextQueuedRunForAgent(f.agent.id)).toEqual([]);
    expect(await f.urgentLog()).toEqual([]);
  });
});
