import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, issues, type Db } from "@paperclipai/db";
import { ISSUE_WAIT_ORPHANED_WAKE_REASON } from "@paperclipai/shared";
import { recoveryService } from "../services/recovery/service.js";
import { ORPHAN_REFUSED_WAKE_RETRY_MS, ORPHAN_WAIT_GRACE_MS, orphanWaitWakeKey } from "../services/recovery/orphan-wait-wakeups.js";
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
