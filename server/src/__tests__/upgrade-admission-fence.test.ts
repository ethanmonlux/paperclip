import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import { createRunDispatch } from "../modules/run-dispatch/index.js";
import { createHeartbeatQueue, type HeartbeatQueueDependencies } from "../services/heartbeat/queue.js";
import { createHeartbeatRunPreparation } from "../services/heartbeat/run-preparation.js";
import { createHeartbeatRunState } from "../services/heartbeat/run-state.js";
import { claimNativeSessionResumptions } from "../services/native-runtime/native-finalization-reconciler.js";
import { errorHandler } from "../middleware/index.js";
import { instanceSettingsRoutes } from "../routes/instance-settings.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// FAC-797 / STA-21 stage 23: persisted upgrade admission fence, phase 1.
// admission-design r2 §3.2–3.7, r3 §3.2/§3.8, r6 §3.10.8. Real embedded
// Postgres, the real heartbeat claim path, the real instance routes. Red on
// c541ff6b because no fence row, lock, route or claim gate exists there; the
// fence module is imported optionally so a missing module fails by assertion.

type FenceModule = typeof import("../services/upgrade-admission-fence.js");
const fence = await import("../services/upgrade-admission-fence.js").catch(() => null) as FenceModule | null;

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping upgrade admission fence tests on this host: ${support.reason ?? "unsupported environment"}`);
}

// The design pins one fixed two-key advisory lock (r2 §3.2).
const LOCK_CLASS = 0x50435546;
const LOCK_OBJECT = 1;
const FENCE_KEY = "upgrade-admission-fence/v1";
const EPISODE_KEY = "upgrade-bootstrap-episode/v1";

type Run = typeof heartbeatRuns.$inferSelect;

function fenceState(phase: string, extra: Record<string, unknown> = {}) {
  return {
    version: 1, epoch: 3, phase, initializedBy: "fresh_install", initializationId: randomUUID(),
    initializedAt: new Date().toISOString(), identity: null, owner: null, heldUntil: null, leaseUntil: null,
    reason: null, candidate: null, history: [], ...extra,
  };
}
const OWNER_HASH = "a".repeat(64);
const heldState = (heldUntil: Date, extra: Record<string, unknown> = {}) => fenceState("held", {
  owner: { tokenSha256: OWNER_HASH, actor: { type: "user", id: "owner" }, heldAt: new Date().toISOString() },
  heldUntil: heldUntil.toISOString(), ...extra,
});
const inAnHour = () => new Date(Date.now() + 3600_000);

describeEmbedded("upgrade admission fence, phase 1", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let other: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("upgrade-admission-fence-");
    db = createDb(temporary.connectionString);
    other = createDb(temporary.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await other?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });
  beforeEach(async () => {
    await db.delete(instanceSettings).where(sql`${instanceSettings.singletonKey} in (${FENCE_KEY}, ${EPISODE_KEY})`);
  });
  afterEach(() => {
    fence?.configureUpgradeAdmissionFenceMode("test_absent_open");
  });

  /** Production mode: an absent row refuses. Old code has no mode, so nothing refuses there. */
  const requireFenceRow = () => fence?.configureUpgradeAdmissionFenceMode("required");

  async function putFence(general: unknown) {
    await db.delete(instanceSettings).where(eq(instanceSettings.singletonKey, FENCE_KEY));
    await db.insert(instanceSettings).values({ singletonKey: FENCE_KEY, general: general as Record<string, unknown> });
  }
  async function readFence() {
    const [row] = await db.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, FENCE_KEY));
    return row ?? null;
  }

  function queueService() {
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
      canStartNewExternalBotWork: async () => true,
      getWorktreeExecutionCutoff: async () => null,
      applyRunDispatchPostCommitEffects: () => {},
      issuesSvc: { getDependencyReadiness: vi.fn(), listDependencyReadiness: async () => new Map() },
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
      releaseIssueExecutionAndPromote: async () => ({ postCommitEffects: [] }),
      publishRunLifecyclePluginEvent: () => {},
      cancelRunInternal: async () => undefined,
      cancelActiveForAgentInternal: async () => undefined,
      resumeExecutionWaitComments: async () => undefined,
      resumeQueuedCommentInterrupt: async () => undefined,
      resumeSavedLegacyComments: async () => undefined,
      formatIssueIdentifierLink: (_identifier: string | null, fallback: string) => fallback,
      sweepPendingCleanupLeases: vi.fn(),
    } as unknown as HeartbeatQueueDependencies;
    return createHeartbeatQueue(db, deps);
  }

  async function claim(run: Run) {
    return queueService().claimQueuedRun(run, undefined, []).catch(() => null);
  }

  async function fixture(options: { queuedComment?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const runId = randomUUID(), wakeId = randomUUID(), commentId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Fence fixture", issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Engineer", role: "engineer", status: "idle", adapterType: "codex_local",
      runtimeConfig: { heartbeat: { wakeOnDemand: true } },
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Fenced work", status: "todo", assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    const context: Record<string, unknown> = { issueId, taskId: issueId, wakeReason: "issue_assigned" };
    const payload: Record<string, unknown> = { issueId };
    if (options.queuedComment) {
      await db.insert(issueComments).values({ id: commentId, companyId, issueId, body: "please continue", authorUserId: "user-1" });
      context.wakeReason = "issue_commented";
      context.wakeCommentIds = [commentId];
      payload._paperclipWakeContext = { wakeCommentIds: [commentId] };
    }
    await db.insert(agentWakeupRequests).values({
      id: wakeId, companyId, agentId, source: "automation", triggerDetail: "system", reason: String(context.wakeReason),
      status: "queued", runId, payload,
    });
    const [run] = await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, invocationSource: "automation", status: "queued", runtimeMode: "legacy",
      wakeupRequestId: wakeId, contextSnapshot: context,
    }).returning();
    const read = () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then(rows => rows[0]!);
    const wake = () => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)).then(rows => rows[0]!);
    const issue = () => db.select().from(issues).where(eq(issues.id, issueId)).then(rows => rows[0]!);
    return { companyId, agentId, issueId, run: run!, read, wake, issue };
  }

  async function expectRefused(f: Awaited<ReturnType<typeof fixture>>) {
    const claimed = await claim(f.run);
    expect(claimed?.status ?? null).not.toBe("running");
    const after = await f.read();
    expect(after.status).toBe("queued");
    expect(after.startedAt).toBeNull();
    expect((await f.wake()).status).toBe("queued");
    expect((await f.issue()).executionRunId).toBeNull();
  }

  describe("run-claim gate (real claim path)", () => {
    it("control: an open fence row admits the claim", async () => {
      await putFence(fenceState("open"));
      requireFenceRow();
      const f = await fixture();
      expect((await claim(f.run))?.status).toBe("running");
      expect((await f.read()).status).toBe("running");
    });

    it("control: in the test-only mode an absent row admits the claim (existing suites, N1)", async () => {
      const f = await fixture();
      expect((await claim(f.run))?.status).toBe("running");
    });

    it("a held fence refuses the ordinary claim and leaves the run and wake queued", async () => {
      await putFence(heldState(inAnHour()));
      await expectRefused(await fixture());
    });

    it("a held fence refuses the queued-comment claim before any admission write", async () => {
      await putFence(heldState(inAnHour()));
      const f = await fixture({ queuedComment: true });
      await expectRefused(f);
      const after = await f.read();
      expect((after.runnerProfileJson as Record<string, unknown> | null)?.adapterDispatch).toBeUndefined();
    });

    it.each(["activating", "verifying", "stopped_for_owner"])("phase %s refuses the claim", async (phase) => {
      await putFence(fenceState(phase, phase === "stopped_for_owner" ? {} : { leaseUntil: inAnHour().toISOString() }));
      await expectRefused(await fixture());
    });

    it("an expired held row still refuses until a fence mutation commits the expiry (F8)", async () => {
      await putFence(heldState(new Date(Date.now() - 60_000)));
      await expectRefused(await fixture());
      expect(((await readFence())!.general as Record<string, unknown>).phase).toBe("held");
    });

    it("an existing instance without a fence row stops for its owner: every claim refuses (R11)", async () => {
      requireFenceRow();
      await expectRefused(await fixture());
      await expectRefused(await fixture({ queuedComment: true }));
      expect(await readFence()).toBeNull();
    });

    it.each([
      ["unknown version", { ...fenceState("open"), version: 2 }],
      ["unknown phase", fenceState("draining")],
      ["non-integer epoch", { ...fenceState("open"), epoch: 1.5 }],
      ["not an object", "open"],
      ["held without owner", fenceState("held", { heldUntil: inAnHour().toISOString() })],
    ])("an unreadable row (%s) refuses even in the test-only mode (F18)", async (_label, general) => {
      await putFence(general);
      await expectRefused(await fixture());
    });

    it("a fence mutation holding the exclusive lock makes the claim refuse without waiting (F5)", async () => {
      await putFence(fenceState("open"));
      requireFenceRow();
      const f = await fixture();
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
      const holder = other.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_CLASS}::int4, ${LOCK_OBJECT}::int4)`);
        locked();
        await released;
      });
      await lockTaken;
      try {
        const started = Date.now();
        await expectRefused(f);
        expect(Date.now() - started).toBeLessThan(4000);
      } finally {
        release();
        await holder;
      }
      expect((await claim(f.run))?.status).toBe("running");
    });

    it("the native session-resumption re-open refuses under a held fence and writes nothing (claim-5)", async () => {
      const f = await fixture();
      const nativeRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: nativeRunId, companyId: f.companyId, agentId: f.agentId, invocationSource: "assignment", status: "failed",
        runtimeMode: "native", nativeIssueId: f.issueId, contextSnapshot: { issueId: f.issueId },
        runnerProfileJson: { nativeExecutionInput: { prompt: "resume" }, sessionCheckpoint: { providerSessionId: "provider-session" } },
      });
      await db.insert(nativeRunFinalizations).values({ runId: nativeRunId, companyId: f.companyId, issueId: f.issueId, phase: "retryable_failure" });
      await putFence(heldState(inAnHour()));
      const claims = await claimNativeSessionResumptions({ db, runnerInstanceId: "fence-test", runIds: [nativeRunId] });
      expect(claims).toEqual([]);
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, nativeRunId));
      expect(run!.status).toBe("failed");
      const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, nativeRunId));
      expect(coordinator!.phase).toBe("retryable_failure");
      expect(coordinator!.leaseOwner).toBeNull();

      // Control: once open, the same candidate is re-opened exactly once.
      await putFence(fenceState("open"));
      const reopened = await claimNativeSessionResumptions({ db, runnerInstanceId: "fence-test", runIds: [nativeRunId] });
      expect(reopened.map((entry) => entry.runId)).toEqual([nativeRunId]);
      const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, nativeRunId));
      expect(after!.status).toBe("running");
    });
  });

  describe("gate helper", () => {
    it("exports the pinned lock and refuses inside a REPEATABLE READ transaction (F19)", async () => {
      expect(fence?.UPGRADE_FENCE_LOCK).toEqual({ classId: LOCK_CLASS, objectId: LOCK_OBJECT });
      await putFence(fenceState("open"));
      const admission = await db.transaction(async (tx) =>
        fence?.admitRunClaimUnderUpgradeFence(tx as never, "queue.claim"), { isolationLevel: "repeatable read" });
      expect(admission).toMatchObject({ admitted: false, code: "upgrade_fence_isolation" });
      const readCommitted = await db.transaction(async (tx) =>
        fence?.admitRunClaimUnderUpgradeFence(tx as never, "queue.claim"));
      expect(readCommitted).toMatchObject({ admitted: true, phase: "open" });
    });

    it("sees a fence committed while the claim waited on a row lock (READ COMMITTED, F19)", async () => {
      requireFenceRow();
      await putFence(fenceState("open"));
      const f = await fixture();
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
      const issueLocker = other.transaction(async (tx) => {
        await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
        locked();
        await released;
      });
      await lockTaken;
      const admission = db.transaction(async (tx) => {
        await tx.execute(sql`select 1`); // transaction snapshot would be taken here at REPEATABLE READ
        await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
        return fence?.admitRunClaimUnderUpgradeFence(tx as never, "queue.claim");
      });
      await waitFor(async () => (await lockWaits("transactionid", "tuple")) > 0);
      await other.update(instanceSettings).set({ general: heldState(inAnHour()) })
        .where(eq(instanceSettings.singletonKey, FENCE_KEY));
      release();
      await issueLocker;
      expect(await admission).toMatchObject({ admitted: false, code: "upgrade_fence_held", phase: "held" });
    });

    it("pure expiry: held reopens, activating and verifying stop for the owner, stopped never moves (P3)", () => {
      const now = Date.now();
      const past = new Date(now - 1000).toISOString();
      const parse = (general: unknown) => {
        const parsed = fence?.parseUpgradeFenceGeneral(general);
        if (parsed?.kind !== "valid") throw new Error("expected a valid fence state");
        return parsed.state;
      };
      const held = fence?.expireUpgradeFenceState(parse(heldState(new Date(past))), now);
      expect(held?.state.phase).toBe("open");
      expect(held?.state.owner).toBeNull();
      expect(held?.transition?.reason).toBe("expired_before_activation");
      expect(fence?.expireUpgradeFenceState(parse(fenceState("activating", { leaseUntil: past })), now).state)
        .toMatchObject({ phase: "stopped_for_owner", reason: "activation_lease_expired" });
      expect(fence?.expireUpgradeFenceState(parse(fenceState("verifying", { leaseUntil: past })), now).state)
        .toMatchObject({ phase: "stopped_for_owner", reason: "verification_lease_expired" });
      expect(fence?.expireUpgradeFenceState(parse(fenceState("stopped_for_owner", { leaseUntil: past })), now).transition).toBeNull();
      expect(fence?.expireUpgradeFenceState(parse(heldState(inAnHour())), now).transition).toBeNull();
    });
  });

  async function lockWaits(...events: string[]) {
    const rows = await other.execute(sql`select count(*)::int as n from pg_stat_activity
      where wait_event_type = 'Lock' and wait_event in (${sql.join(events.map((event) => sql`${event}`), sql`, `)})
      and datname = current_database()`) as unknown as Array<{ n: number }>;
    return Number(rows[0]?.n ?? 0);
  }
  async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect.fail(`condition not reached within ${timeoutMs}ms`);
  }

  describe("authenticated hold / abort / status routes", () => {
    const admin = (companyIds: string[] = []) => ({ type: "board", userId: "owner-user", source: "session", isInstanceAdmin: true, companyIds });
    function app(actor: Record<string, unknown>) {
      const server = express();
      server.use(express.json());
      server.use((req, _res, next) => { (req as unknown as { actor: unknown }).actor = actor; next(); });
      server.use("/api", instanceSettingsRoutes(db));
      server.use(errorHandler);
      return server;
    }

    it("status and mutations require an instance admin (F10)", async () => {
      await putFence(fenceState("open"));
      const member = { type: "board", userId: "member", source: "session", isInstanceAdmin: false, companyIds: [] };
      const agent = { type: "agent", agentId: randomUUID(), companyId: randomUUID() };
      for (const actor of [member, agent]) {
        expect((await request(app(actor)).get("/api/instance/upgrade-fence")).status).toBe(403);
        expect((await request(app(actor)).post("/api/instance/upgrade-fence").send({})).status).toBe(403);
        expect((await request(app(actor)).delete("/api/instance/upgrade-fence").send({ epoch: 3, ownerToken: "x" })).status).toBe(403);
      }
      expect(((await readFence())!.general as Record<string, unknown>).phase).toBe("open");
    });

    it("hold → status → abort; one epoch; the token is returned once and never stored or audited (F3, F7, F11, F12)", async () => {
      const f = await fixture();
      await putFence(fenceState("open", { epoch: 3 }));
      const server = app(admin([f.companyId]));

      const status = await request(server).get("/api/instance/upgrade-fence");
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({ phase: "open", epoch: 3, admitsRunClaims: true, present: true });

      const held = await request(server).post("/api/instance/upgrade-fence").send({ ttlSeconds: 600, candidate: { toCommit: "c".repeat(40) } });
      expect(held.status).toBe(200);
      expect(held.body).toMatchObject({ phase: "held", epoch: 4 });
      const token = held.body.ownerToken as string;
      expect(typeof token).toBe("string");
      expect(token.length).toBeGreaterThanOrEqual(32);

      // A second acquisition while held refuses and keeps the epoch.
      const again = await request(server).post("/api/instance/upgrade-fence").send({ ttlSeconds: 600 });
      expect(again.status).toBe(409);
      expect(again.body.details?.code ?? again.body.code).toBe("upgrade_fence_held");

      const afterHold = await request(server).get("/api/instance/upgrade-fence");
      expect(afterHold.body).toMatchObject({ phase: "held", epoch: 4, admitsRunClaims: false });
      expect(JSON.stringify(afterHold.body)).not.toContain(token);

      // Claims refuse while held.
      await expectRefused(f);

      // Token storage and audit: only the hash, never the token.
      const stored = JSON.stringify((await readFence())!.general);
      expect(stored).not.toContain(token);
      expect(stored).toContain(fence?.hashUpgradeFenceToken(token) ?? "missing-hash-function");
      const audit = await db.select().from(activityLog).where(and(
        eq(activityLog.companyId, f.companyId), eq(activityLog.action, "instance.upgrade_fence.held")));
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit)).not.toContain(token);

      // Wrong token or stale epoch: 409, still held.
      const wrongToken = await request(server).delete("/api/instance/upgrade-fence").send({ epoch: 4, ownerToken: "not-the-token" });
      expect(wrongToken.status).toBe(409);
      expect(wrongToken.body.details?.code ?? wrongToken.body.code).toBe("upgrade_fence_stale_owner");
      const wrongEpoch = await request(server).delete("/api/instance/upgrade-fence").send({ epoch: 3, ownerToken: token });
      expect(wrongEpoch.status).toBe(409);
      expect(((await readFence())!.general as Record<string, unknown>).phase).toBe("held");

      const aborted = await request(server).delete("/api/instance/upgrade-fence").send({ epoch: 4, ownerToken: token, reason: "test abort" });
      expect(aborted.status).toBe(200);
      expect(aborted.body).toMatchObject({ phase: "open", epoch: 4 });
      const reopened = (await readFence())!.general as Record<string, unknown>;
      expect(reopened).toMatchObject({ phase: "open", epoch: 4, owner: null });
      expect((reopened.history as Array<Record<string, unknown>>).map((entry) => entry.to)).toEqual(["held", "open"]);
      expect(await db.select().from(activityLog).where(and(
        eq(activityLog.companyId, f.companyId), eq(activityLog.action, "instance.upgrade_fence.aborted")))).toHaveLength(1);

      // Released: the queued run is claimable again.
      expect((await claim(f.run))?.status).toBe("running");
    });

    it("abort refuses in every phase other than held (F28)", async () => {
      const server = app(admin());
      for (const phase of ["open", "activating", "verifying", "stopped_for_owner"]) {
        await putFence(fenceState(phase, phase === "activating" || phase === "verifying" ? { leaseUntil: inAnHour().toISOString() } : {}));
        const response = await request(server).delete("/api/instance/upgrade-fence").send({ epoch: 3, ownerToken: "anything" });
        expect(response.status).toBe(409);
        expect(response.body.details?.code ?? response.body.code).toBe("upgrade_fence_not_abortable");
        expect(((await readFence())!.general as Record<string, unknown>).phase).toBe(phase);
      }
    });

    it("hold refuses outside open; an invalid ttl writes nothing", async () => {
      const server = app(admin());
      await putFence(fenceState("stopped_for_owner"));
      const stopped = await request(server).post("/api/instance/upgrade-fence").send({});
      expect(stopped.status).toBe(409);
      expect(stopped.body.details?.code ?? stopped.body.code).toBe("upgrade_fence_not_holdable");
      await putFence(fenceState("open"));
      expect((await request(server).post("/api/instance/upgrade-fence").send({ ttlSeconds: 5 })).status).toBe(400);
      expect(((await readFence())!.general as Record<string, unknown>)).toMatchObject({ phase: "open", epoch: 3 });
    });

    it("a missing row is reported stopped for the owner and never recreated by a mutation (F17b)", async () => {
      requireFenceRow();
      const server = app(admin());
      const status = await request(server).get("/api/instance/upgrade-fence");
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({ present: false, phase: "stopped_for_owner", reason: "fence_row_missing", admitsRunClaims: false });
      const held = await request(server).post("/api/instance/upgrade-fence").send({});
      expect(held.status).toBe(409);
      expect(held.body.details?.code ?? held.body.code).toBe("fence_row_missing");
      const aborted = await request(server).delete("/api/instance/upgrade-fence").send({ epoch: 0, ownerToken: "x" });
      expect(aborted.status).toBe(409);
      expect(await readFence()).toBeNull();
    });

    it("status is read-only for an expired hold; the next mutation commits the expiry at database time (F8)", async () => {
      const server = app(admin());
      await putFence(heldState(new Date(Date.now() - 60_000), { epoch: 7 }));
      const status = await request(server).get("/api/instance/upgrade-fence");
      expect(status.body).toMatchObject({ phase: "held", expiryPending: true, admitsRunClaims: false });
      expect(((await readFence())!.general as Record<string, unknown>).phase).toBe("held");

      const held = await request(server).post("/api/instance/upgrade-fence").send({ ttlSeconds: 120 });
      expect(held.status).toBe(200);
      expect(held.body).toMatchObject({ phase: "held", epoch: 8 });
      const history = ((await readFence())!.general as Record<string, unknown>).history as Array<Record<string, unknown>>;
      expect(history.map((entry) => `${entry.from}->${entry.to}:${entry.reason}`)).toEqual([
        "held->open:expired_before_activation", "open->held:held_by_owner",
      ]);
    });

    it("the periodic sweep commits due expiries by the phase table and leaves stopped alone (P3)", async () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const sweep = () => fence?.upgradeAdmissionFenceService(db as never).sweepExpired();
      await putFence(heldState(new Date(past)));
      expect((await sweep())?.reason).toBe("expired_before_activation");
      expect(((await readFence())!.general as Record<string, unknown>)).toMatchObject({ phase: "open", owner: null });
      await putFence(fenceState("verifying", { leaseUntil: past }));
      expect((await sweep())?.reason).toBe("verification_lease_expired");
      expect(((await readFence())!.general as Record<string, unknown>).phase).toBe("stopped_for_owner");
      await putFence(fenceState("stopped_for_owner", { leaseUntil: past }));
      expect(await sweep()).toBeNull();
      await putFence(heldState(inAnHour()));
      expect(await sweep()).toBeNull();
    });

    it("an in-flight claim holding the shared lock makes the hold wait until it commits (F4)", async () => {
      await putFence(fenceState("open"));
      const server = app(admin());
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
      const claimInFlight = other.transaction(async (tx) => {
        await tx.execute(sql`select pg_try_advisory_xact_lock_shared(${LOCK_CLASS}::int4, ${LOCK_OBJECT}::int4)`);
        locked();
        await released;
      });
      await lockTaken;
      const holding = request(server).post("/api/instance/upgrade-fence").send({ ttlSeconds: 600 }).then((response) => response);
      try {
        await waitFor(async () => (await lockWaits("advisory")) > 0);
        expect(((await readFence())!.general as Record<string, unknown>).phase).toBe("open");
      } finally {
        release();
        await claimInFlight;
      }
      const response = await holding;
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ phase: "held", epoch: 4 });
    });

    it("two concurrent first holds produce exactly one epoch (F16)", async () => {
      await putFence(fenceState("open", { epoch: 0 }));
      const server = app(admin());
      const responses = await Promise.all([1, 2].map(() => request(server).post("/api/instance/upgrade-fence").send({ ttlSeconds: 600 })));
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      expect(((await readFence())!.general as Record<string, unknown>)).toMatchObject({ phase: "held", epoch: 1 });
    });
  });

  describe("initialization and boot", () => {
    it("fresh_install initializes only in the invocation that created the migration journal (F35)", async () => {
      await expect(fence?.initializeUpgradeAdmissionFence(db as never, { mode: "fresh_install", createdMigrationJournal: false }) ?? Promise.resolve("missing"))
        .rejects.toMatchObject({ code: "fence_init_requires_bootstrap" });
      expect(await readFence()).toBeNull();

      expect(await fence?.initializeUpgradeAdmissionFence(db as never, { mode: "fresh_install", createdMigrationJournal: true })).toEqual({ created: true });
      expect(((await readFence())!.general as Record<string, unknown>)).toMatchObject({ version: 1, epoch: 0, phase: "open", initializedBy: "fresh_install" });
      const [episode] = await db.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, EPISODE_KEY));
      expect((episode!.general as Record<string, unknown>).current).toMatchObject({ kind: "fresh_install", state: "committed" });
    });

    it("an initializer never overwrites a present row", async () => {
      await putFence(heldState(inAnHour(), { epoch: 9 }));
      expect(await fence?.initializeUpgradeAdmissionFence(db as never, { mode: "fresh_install", createdMigrationJournal: true })).toEqual({ created: false });
      expect(((await readFence())!.general as Record<string, unknown>)).toMatchObject({ phase: "held", epoch: 9 });
    });

    it("boot of an existing database writes nothing and reports stopped for the owner; claims refuse (R11)", async () => {
      requireFenceRow();
      const status = await fence?.bootUpgradeAdmissionFence(db as never, { createdMigrationJournal: false });
      expect(status).toMatchObject({ phase: "stopped_for_owner", reason: "fence_row_missing", admitsRunClaims: false });
      expect(await readFence()).toBeNull();
      await expectRefused(await fixture());
    });

    it("boot of a freshly created database initializes open and admits claims", async () => {
      requireFenceRow();
      const status = await fence?.bootUpgradeAdmissionFence(db as never, { createdMigrationJournal: true });
      expect(status).toMatchObject({ phase: "open", epoch: 0, admitsRunClaims: true });
      const f = await fixture();
      expect((await claim(f.run))?.status).toBe("running");
    });
  });
});

describe("upgrade admission fence wiring (structural)", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  it("server boot reads/initializes the fence before startup recovery and only a fresh journal initializes", () => {
    const index = read("../index.ts");
    const boot = index.indexOf("bootUpgradeAdmissionFence(");
    expect(boot).toBeGreaterThan(-1);
    expect(boot).toBeLessThan(index.indexOf("const startupHeartbeatRecovery = (async"));
    expect(index).toMatch(/state\.reason === "no-migration-journal-empty-db"[\s\S]{0,400}createdMigrationJournal = true/);
    expect(index.match(/createdMigrationJournal = true/g)?.length).toBe(1);
    expect(index).not.toContain("configureUpgradeAdmissionFenceMode");
  });

  it("no other server file writes `status: \"running\"` without being classified (N6 scan)", () => {
    const root = new URL("../", import.meta.url);
    const files: string[] = [];
    const walk = (dir: URL) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
        if (entry.isDirectory()) walk(child);
        else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.") && !entry.name.includes("test-fixture")
          && readFileSync(child, "utf8").includes('status: "running"')) files.push(child.pathname.slice(root.pathname.length));
      }
    };
    walk(root);
    // Gated heartbeat_runs claim writers (inventory below) and writers of other tables' own `running` states.
    const classified = new Set([
      "services/heartbeat/queue.ts", "services/native-runtime/native-review-dispatch.ts",
      "services/native-runtime/native-session-executor.ts", "services/native-runtime/status-decision-committer.ts",
      "services/native-runtime/native-restart-recovery.ts", "services/native-runtime/native-finalization-reconciler.ts",
      "services/native-runtime/native-workspace-export-recovery.ts", "services/native-runtime/native-workspace-export-retry.ts",
      // other tables (company transfer, browser-use runs, skills jobs, fast responses, agents, plugin jobs, smoke lab,
      // status cards, tool runtimes, workspace operations, runtime services): effect/state rows of later phases or not runs
      "routes/companies.ts", "services/browser-use.ts", "services/company-skills.ts", "services/company-transfer-runs.ts",
      "services/fast-responses.ts", "services/heartbeat.ts", "services/plugin-job-store.ts", "services/smoke-lab.ts",
      "services/status-cards.ts", "services/tool-runtime-supervisor.ts", "services/workspace-operations.ts",
      "services/workspace-runtime.ts",
    ]);
    expect(files.filter((file) => !classified.has(file)).sort()).toEqual([]);
  });

  it("every heartbeat run → running writer is either gated or classified (N6, phase-1 claim inventory)", () => {
    // file → [occurrences of `status: "running"`, gate calls expected, classification]
    const inventory: Record<string, { running: number; gates: number }> = {
      "../services/heartbeat/queue.ts": { running: 3, gates: 2 },
      "../services/native-runtime/native-review-dispatch.ts": { running: 1, gates: 1 },
      "../services/native-runtime/native-session-executor.ts": { running: 1, gates: 1 },
      "../services/native-runtime/status-decision-committer.ts": { running: 1, gates: 1 },
      "../services/native-runtime/native-restart-recovery.ts": { running: 1, gates: 1 },
      "../services/native-runtime/native-finalization-reconciler.ts": { running: 1, gates: 1 },
      "../services/native-runtime/native-workspace-export-recovery.ts": { running: 1, gates: 1 },
      "../services/native-runtime/native-workspace-export-retry.ts": { running: 1, gates: 1 },
    };
    for (const [path, expected] of Object.entries(inventory)) {
      const source = read(path);
      expect([path, source.match(/status: "running"/g)?.length ?? 0]).toEqual([path, expected.running]);
      expect([path, source.match(/(admit|assert)RunClaimUnderUpgradeFence\(/g)?.length ?? 0]).toEqual([path, expected.gates]);
    }
  });
});
