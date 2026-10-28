import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { eq } from "drizzle-orm";
import {
  agents, companies, environmentLeases, heartbeatRunEvents, heartbeatRuns,
  issueRecoveryActions, issues, nativeRunFinalizations, createDb,
  getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, type Db,
} from "@paperclipai/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agentExecutionsHaveStopped } from "./agent-execution-stop.js";
import { legacyControllerBootId } from "./legacy-controller-lease.js";
import { createLifecycleStore } from "../modules/agent-lifecycle/adapters/postgres.js";
import { createLifecycleWorker } from "../modules/agent-lifecycle/application/worker.js";
import type { LifecycleEffects } from "../modules/agent-lifecycle/adapters/effects.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("reconciled legacy pre-dispatch stop proof", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  let otherCompanyId: string;
  let agentId: string;
  let otherAgentId: string;
  let issueId: string;
  let otherIssueId: string;
  const finishedAt = new Date("2026-01-01T00:00:01.000Z");
  const recordedAt = "2026-01-01T00:01:01.000Z";
  const resolvedAt = new Date("2026-01-01T00:01:01.100Z");

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-legacy-stop-proof-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(async () => {
    companyId = randomUUID();
    otherCompanyId = randomUUID();
    await db.insert(companies).values([companyId, otherCompanyId].map(id => ({
      id, name: "Stop proof", issuePrefix: `S${id.slice(0, 7)}`,
    })));
    const rows = await db.insert(agents).values(["Original", "Other"].map(name => ({
      companyId, name, adapterType: "claude_local", status: "paused", lifecycleState: "pausing" as const,
      lifecycleHolds: [], lifecycleVersion: 1, lifecycleRequiredPluginIds: [],
      lifecycleOperation: { id: randomUUID(), hostComplete: false, completedPluginIds: [], attempts: 0, resumeState: "ready" as const },
    }))).returning();
    [agentId, otherAgentId] = rows.map(row => row.id);
    const tasks = await db.insert(issues).values(["Original task", "Other task"].map(title => ({
      companyId, title, assigneeAgentId: agentId,
    }))).returning();
    [issueId, otherIssueId] = tasks.map(row => row.id);
  });

  async function seed(options: {
    run?: Partial<typeof heartbeatRuns.$inferInsert>;
    action?: Partial<typeof issueRecoveryActions.$inferInsert>;
    decision?: Record<string, unknown>;
    withoutReceipt?: boolean;
  } = {}) {
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId, scopeKind: "issue", issueId, status: "cancelled", invocationSource: "on_demand",
      runtimeMode: "legacy", executionStage: "preparing", errorCode: "continuation_task_ownership_changed",
      startedAt: new Date("2026-01-01T00:00:00.000Z"), finishedAt,
      controllerBootId: randomUUID(), controllerLeaseExpiresAt: new Date("2026-01-01T00:01:00.000Z"),
      contextSnapshot: { issueId, taskId: issueId }, runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } },
      sessionIdBefore: "preserved-prior-session",
      resultJson: { startupCancellation: { beforeNativeSelection: false, requestedAt: finishedAt.toISOString() } },
      ...options.run,
    }).returning();
    if (options.withoutReceipt) return { run, action: null };
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId: issueId, kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation",
      status: "resolved", outcome: "handed_back", returnOwnerAgentId: agentId, ownerType: "user", ownerUserId: "board-test",
      fingerprint: randomUUID(), nextAction: "Preserve the reconciled history", resolvedAt,
      evidence: {
        runId: run.id,
        executionReconciliation: {
          runId: run.id, providerStopped: true, actionOutcome: "not_performed",
          outcomeEvidence: "The stale continuation was cancelled before adapter dispatch. No provider work started.",
          actorId: "board-test", recordedAt, ...options.decision,
        },
      },
      ...options.action,
    }).returning();
    return { run, action };
  }

  it("accepts the resolved pre-dispatch receipt without rewriting the cancelled run or task history", async () => {
    const { run, action } = await seed();
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: run.id, seq: 1,
      eventType: "lifecycle", stream: "system", message: "stale execution continuation cancelled before dispatch" });
    await db.insert(environmentLeases).values({ companyId, heartbeatRunId: run.id, provider: "local",
      status: "expired", releasedAt: finishedAt });
    await db.update(issues).set({ status: "done", assigneeAgentId: otherAgentId }).where(eq(issues.id, issueId));
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(true);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]).toEqual(run);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id)))[0]).toEqual(action);
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({ status: "done", assigneeAgentId: otherAgentId });
  });

  it("keeps the hold without a reconciliation receipt", async () => {
    await seed({ withoutReceipt: true });
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
  });

  it.each([
    "company", "task", "agent", "status", "kind", "cause", "outcome", "source run", "resolved time",
  ])("rejects a mismatched or unresolved receipt: %s", async field => {
    const { run, action } = await seed();
    const patches: Record<string, Partial<typeof issueRecoveryActions.$inferInsert>> = {
      company: { companyId: otherCompanyId }, task: { sourceIssueId: otherIssueId }, agent: { returnOwnerAgentId: otherAgentId },
      status: { status: "active" }, kind: { kind: "account_recovery" }, cause: { cause: "other_recovery" },
      outcome: { outcome: "cancelled" }, "source run": { evidence: { ...action!.evidence, runId: randomUUID() } },
      "resolved time": { resolvedAt: null },
    };
    await db.update(issueRecoveryActions).set(patches[field]).where(eq(issueRecoveryActions.id, action!.id));
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]).toEqual(run);
  });

  it.each([
    ["run", { runId: "00000000-0000-0000-0000-000000000001" }],
    ["provider still active", { providerStopped: false }],
    ["completed work", { actionOutcome: "completed" }],
    ["mixed work", { actionOutcome: "mixed" }],
    ["missing evidence", { outcomeEvidence: "  " }],
    ["missing actor", { actorId: "" }],
    ["missing timestamp", { recordedAt: null }],
    ["invalid timestamp", { recordedAt: "invalid" }],
    ["premature timestamp", { recordedAt: "2025-12-31T23:59:59.000Z" }],
    ["unresolved timestamp", { recordedAt: "2026-01-01T00:02:00.000Z" }],
  ] as const)("rejects incomplete or contradictory operator evidence: %s", async (_label, decision) => {
    await seed({ decision });
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
  });

  it.each([
    "native runtime", "different stop", "dispatching", "native issue", "native session", "provider session",
    "process birth", "runtime selected", "runner instance", "external run", "provider output", "current controller",
    "missing controller lease", "live controller lease", "unknown adapter", "conflicting issue", "conflicting task", "invalid task",
  ])("does not widen the pre-dispatch exception: %s", async field => {
    const changes: Record<string, Partial<typeof heartbeatRuns.$inferInsert>> = {
      "native runtime": { runtimeMode: "native" }, "different stop": { errorCode: "cancelled" },
      dispatching: { executionStage: "dispatching" }, "native issue": { nativeIssueId: issueId },
      "native session": { nativeSessionId: randomUUID() }, "provider session": { sessionIdAfter: "new-session" },
      "process birth": { processStartedAt: finishedAt }, "runtime selected": { runtimeModeResolvedAt: finishedAt },
      "runner instance": { runnerInstanceId: randomUUID() }, "external run": { externalRunId: "remote-run" },
      "provider output": { stdoutExcerpt: "provider output" }, "current controller": { controllerBootId: legacyControllerBootId },
      "missing controller lease": { controllerLeaseExpiresAt: null },
      "live controller lease": { controllerLeaseExpiresAt: new Date(Date.now() + 60_000) },
      "unknown adapter": { runnerProfileJson: null }, "conflicting issue": { issueId: otherIssueId },
      "conflicting task": { contextSnapshot: { issueId, taskId: otherIssueId } },
      "invalid task": { contextSnapshot: { issueId: "not-a-uuid" } },
    };
    await seed({ run: changes[field] });
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
  });

  it.each([
    "adapter.invoke", "native.process_start_requested", "native.process_identity_recorded", "harness.ready",
    "session.started", "session.resumed", "session.updated", "turn.started", "provider.event", "provider.rpc_result",
    "tool.execution.started",
  ])("rejects retained execution evidence: %s", async eventType => {
    const { run } = await seed();
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: run.id, seq: 1, eventType });
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
  });

  it.each([
    { sourceEventId: "provider-event" }, { sourceInstanceId: "provider-instance" }, { sourceSeq: 1 },
    { stream: "stdout" }, { stream: "stderr" },
  ])("rejects source-tagged or output evidence: %j", async evidence => {
    const { run } = await seed();
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: run.id, seq: 1, eventType: "lifecycle", ...evidence });
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
  });

  it("does not let a receipt override a live local process", async () => {
    await seed({ run: { processPid: process.pid } });
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
  });

  it.skipIf(process.platform === "win32")("does not let a receipt override a live detached process group", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    await once(child, "spawn");
    try {
      await seed({ run: { processGroupId: child.pid! } });
      expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
    } finally {
      const closed = once(child, "close");
      process.kill(-child.pid!, "SIGKILL");
      await closed;
    }
  });

  it.each([
    { status: "active", releasedAt: null, cleanupStatus: null },
    { status: "pending_cleanup", releasedAt: finishedAt, cleanupStatus: null },
    { status: "released", releasedAt: finishedAt, cleanupStatus: "failed" },
  ])("preserves environment cleanup gates: %j", async cleanup => {
    const { run } = await seed();
    await db.insert(environmentLeases).values({ companyId, heartbeatRunId: run.id, provider: "local", ...cleanup });
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
  });

  it.each(["live lease", "live controller"])("preserves native finalization ownership gates: %s", async gate => {
    await seed();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: otherIssueId,
      status: "cancelled", invocationSource: "on_demand", runtimeMode: "native", startedAt: finishedAt,
      finishedAt, processPid: 2_000_000_000 }).returning();
    await db.insert(nativeRunFinalizations).values({ companyId, issueId: otherIssueId, runId: run.id, phase: "executing",
      leaseOwner: "other-controller", leaseExpiresAt: gate === "live lease" ? new Date(Date.now() + 60_000) : new Date(0),
      controllerPid: gate === "live controller" ? process.pid : null });
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
  });

  it.each([false, true])("lets the existing lifecycle finish while preserving a manual hold=%s", async manualHold => {
    const { run } = await seed();
    if (manualHold) await db.update(agents).set({ lifecycleHolds: ["manual"], pauseReason: "manual" }).where(eq(agents.id, agentId));
    const effects = {
      transaction: async (_db: Db, _companyId: string, work: (tx: Db) => Promise<unknown>) => db.transaction(tx => work(tx)),
      notifyWork: async () => {}, recordStatus: async () => {},
    } as unknown as LifecycleEffects;
    const worker = createLifecycleWorker(createLifecycleStore(db, effects), {
      requiredPluginIds: async () => [], runPlugin: async () => "complete",
      runHost: async agent => await agentExecutionsHaveStopped(db, [agent.id]) ? "complete" : "pending",
    }, () => {});
    try { await worker.process(agentId); } finally { await worker.stop(); }
    expect((await db.select().from(agents).where(eq(agents.id, agentId)))[0]).toMatchObject({
      lifecycleState: manualHold ? "paused" : "ready", status: manualHold ? "paused" : "idle",
      lifecycleHolds: manualHold ? ["manual"] : [],
    });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]).toEqual(run);
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).toHaveLength(1);
  });
});
