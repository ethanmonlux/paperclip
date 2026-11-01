import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

// STA-21 stage 12 (FAC-760): runs 19befcbc and d79920b9 finished with a
// successful provider result and were persisted `cancelled` with cancellation
// source `unknown`. The local adapters do not observe the host abort signal,
// so a host-side abort during the turn is only seen at completion. The legacy
// controller lease watchdog is the one host abort that records nothing. These
// cases drive the assembled heartbeat on real Postgres and inject that abort.

type AdapterResult = Record<string, unknown>;
const adapterExecute = vi.hoisted(() => vi.fn(async (): Promise<AdapterResult> => ({
  exitCode: 0, signal: null, timedOut: false, summary: "done", provider: "test", model: "test-model",
})));

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ type: "process", execute: adapterExecute, supportsLocalAgentJwt: false }),
  findActiveServerAdapter: () => ({ type: "process", execute: adapterExecute, supportsLocalAgentJwt: false }),
  runningProcesses: new Map(),
}));

import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import * as controllerLeases from "../services/legacy-controller-lease.js";

// The terminal frame the incident runs persisted: provider success, cleaned up.
const providerSuccess = (): AdapterResult => ({
  exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Turn complete.",
  provider: "test", model: "test-model",
  resultJson: { type: "result", subtype: "success", is_error: false, terminal_reason: "completed",
    adapterCompletion: { reason: "successful_terminal_result_cleanup", processSignal: "SIGTERM", processExitCode: null } },
});

type Watch = { tick: () => void; controller: AbortController; failNextRenewal: () => void };

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("legacy controller lease loss at the host completion boundary", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const projectId = randomUUID();
  const projectWorkspaceId = randomUUID();
  let watch: Watch | null = null;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("legacy-lease-host-cancel-");
    db = createDb(database.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: false });
    await db.insert(companies).values({ id: companyId, name: "Lease loss", issuePrefix: "LLH",
      status: "active", defaultResponsibleUserId: "responsible-user" });
    // Upstream requires the responsible user to be an active company member.
    await db.insert(authUsers).values({ id: "responsible-user", name: "Responsible user",
      email: "lease-loss@example.test", createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user",
      status: "active", membershipRole: "member" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Lease project", status: "active" });
    await db.insert(projectWorkspaces).values({ id: projectWorkspaceId, companyId, projectId, name: "Primary",
      cwd: fileURLToPath(new URL("../../../", import.meta.url)), isPrimary: true });
    // Capture the run's watchdog: its renewal tick and controller, plus a
    // one-shot transient database error on the next renewal's first database
    // call (a direct UPDATE here; upstream renews inside a transaction).
    const originalWatch = controllerLeases.watchLegacyControllerLease;
    vi.spyOn(controllerLeases, "watchLegacyControllerLease").mockImplementation(((leaseDb, run, controller, ...rest) => {
      let failNext = false;
      const wrapped = new Proxy(leaseDb, {
        get(target, prop, receiver) {
          if ((prop === "update" || prop === "transaction") && failNext) {
            failNext = false;
            return () => { throw new Error("Connection terminated unexpectedly"); };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const realSetInterval = globalThis.setInterval;
      let tick: (() => void) | undefined;
      globalThis.setInterval = ((fn: () => void, ms?: number) => {
        if (ms === controllerLeases.LEGACY_CONTROLLER_RENEW_MS) tick = fn;
        return realSetInterval(fn, ms);
      }) as typeof setInterval;
      let lease: ReturnType<typeof originalWatch>;
      try {
        lease = (originalWatch as (...args: unknown[]) => ReturnType<typeof originalWatch>)(wrapped, run, controller, ...rest);
      } finally {
        globalThis.setInterval = realSetInterval;
      }
      watch = { tick: tick ?? (() => { throw new Error("no renewal tick captured"); }), controller,
        failNextRenewal: () => { failNext = true; } };
      return lease;
    }) as typeof originalWatch);
  }, 60_000);

  afterAll(async () => {
    if (database) {
      await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
      await database.cleanup();
    }
  });

  beforeEach(() => {
    watch = null;
    adapterExecute.mockReset();
  });

  async function seedIssue() {
    const agentId = randomUUID(), issueId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: `Agent ${agentId.slice(0, 6)}`, adapterType: "process",
      status: "idle", runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, projectId, projectWorkspaceId, title: "Lease loss turn",
      status: "in_progress", workMode: "standard", assigneeAgentId: agentId });
    return { agentId, issueId };
  }

  async function runTurn(agentId: string, issueId: string) {
    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId }, contextSnapshot: { issueId, taskId: issueId, skipIssueComment: true } });
    expect(queued).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id));
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, queued!.id));
    return { heartbeat, run: run!, events };
  }

  async function waitFor(check: () => boolean | Promise<boolean>, label: string) {
    for (let i = 0; i < 400; i += 1) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  async function loseLease(runId: string, how: "renewal_error" | "renewal_rejected") {
    const current = watch!;
    if (how === "renewal_error") current.failNextRenewal();
    else await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(heartbeatRuns.id, runId));
    current.tick();
    await waitFor(() => current.controller.signal.aborted, "lease watchdog abort");
    return current.controller.signal.reason as Error & { leaseLossCause?: string };
  }

  function cancelledEvent(events: Array<typeof heartbeatRunEvents.$inferSelect>) {
    return events.find((event) => event.message === "run cancelled")?.payload as Record<string, unknown> | undefined;
  }

  it.each(["renewal_error", "renewal_rejected"] as const)(
    "attributes a %s lease loss behind a successful provider turn instead of recording an unknown stop",
    async (how) => {
      const { agentId, issueId } = await seedIssue();
      let abortReason: (Error & { leaseLossCause?: string }) | undefined;
      adapterExecute.mockImplementationOnce(async () => {
        const [current] = await db.select().from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running")));
        abortReason = await loseLease(current!.id, how);
        // Like claude_local, the adapter does not observe the host signal:
        // the provider finishes its turn and reports success.
        return providerSuccess();
      });
      const { run, events } = await runTurn(agentId, issueId);

      if (adapterExecute.mock.calls.length !== 1) throw new Error(`adapter not called: ${run.status} ${run.errorCode} ${run.error}`);
      expect(abortReason?.message).toMatch(/^Legacy controller lease lost/);
      // The outcome itself is unchanged: this host lost ownership. These are
      // the incident runs' persisted fields.
      expect(run.status).toBe("cancelled");
      expect(run.errorCode).toBe("cancelled");
      expect(run.error).toBe("Cancelled");
      expect(run.exitCode).toBe(0);
      expect(run.resultJson).toMatchObject({ subtype: "success",
        adapterCompletion: { reason: "successful_terminal_result_cleanup" } });
      expect(run.resultJson?.cancellation).toMatchObject({ source: "controller_lease", expected: false,
        initiator: { type: "system" }, reason: `Legacy controller lease lost (${how})` });
      expect(abortReason?.leaseLossCause).toBe(how);
      expect(run.resultJson?.controllerLeaseLoss).toMatchObject({ cause: how });
      expect(typeof (run.resultJson?.controllerLeaseLoss as Record<string, unknown>)?.sinceRenewalMs).toBe("number");
      expect(cancelledEvent(events)?.cancellation).toMatchObject({ source: "controller_lease" });
    },
    60_000,
  );

  it("attributes a lease loss when the adapter throws after the abort", async () => {
    const { agentId, issueId } = await seedIssue();
    adapterExecute.mockImplementationOnce(async () => {
      const [current] = await db.select().from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running")));
      await loseLease(current!.id, "renewal_error");
      throw new Error("adapter stream closed");
    });
    const { run } = await runTurn(agentId, issueId);
    expect(run.status).toBe("cancelled");
    expect(run.resultJson?.cancellation).toMatchObject({ source: "controller_lease", expected: false,
      reason: "Legacy controller lease lost (renewal_error)" });
    expect(run.resultJson?.controllerLeaseLoss).toMatchObject({ cause: "renewal_error" });
  }, 60_000);

  // Negative controls: these hold on the unmodified head too.
  it("a healthy renewal leaves a successful provider turn succeeded", async () => {
    const { agentId, issueId } = await seedIssue();
    adapterExecute.mockImplementationOnce(async () => {
      const current = watch!;
      current.tick();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(current.controller.signal.aborted).toBe(false);
      return providerSuccess();
    });
    const { run } = await runTurn(agentId, issueId);
    expect(run.status).toBe("succeeded");
    expect(run.resultJson?.cancellation).toBeUndefined();
    expect(run.resultJson?.controllerLeaseLoss).toBeUndefined();
  }, 60_000);

  it("a real provider failure without lease loss stays failed", async () => {
    const { agentId, issueId } = await seedIssue();
    adapterExecute.mockImplementationOnce(async () => ({ exitCode: 1, signal: null, timedOut: false,
      errorMessage: "provider exited 1", summary: "", provider: "test", model: "test-model" }));
    const { run } = await runTurn(agentId, issueId);
    expect(run.status).toBe("failed");
    expect(run.resultJson?.controllerLeaseLoss).toBeUndefined();
  }, 60_000);

  it("a timed-out turn without lease loss stays timed out", async () => {
    const { agentId, issueId } = await seedIssue();
    adapterExecute.mockImplementationOnce(async () => ({ exitCode: null, signal: "SIGTERM", timedOut: true,
      errorMessage: "Timed out", summary: "", provider: "test", model: "test-model" }));
    const { run } = await runTurn(agentId, issueId);
    expect(run.status).toBe("timed_out");
    expect(run.resultJson?.controllerLeaseLoss).toBeUndefined();
  }, 60_000);

  it.each([false, true])("an operator Stop keeps precedence (lease lost first: %s)", async (leaseLostFirst) => {
    const { agentId, issueId } = await seedIssue();
    let stop: Promise<unknown> | null = null;
    let heartbeatForStop: ReturnType<typeof heartbeatService> | null = null;
    adapterExecute.mockImplementationOnce(async () => {
      const [current] = await db.select().from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running")));
      if (leaseLostFirst) await loseLease(current!.id, "renewal_error");
      heartbeatForStop = heartbeatService(db);
      stop = heartbeatForStop.cancelRun(current!.id, "Operator stopped the run", {
        resultJson: { cancelledByActorType: "user", cancelledByUserId: "responsible-user" },
      });
      await waitFor(async () => {
        const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, current!.id));
        return row?.error === "Operator stopped the run";
      }, "operator stop write");
      return providerSuccess();
    });
    const { run } = await runTurn(agentId, issueId);
    await stop;
    expect(run.status).toBe("cancelled");
    expect(run.resultJson?.cancellation).toMatchObject({ source: "operator", expected: true,
      initiator: { type: "user", id: "responsible-user" } });
  }, 60_000);
});
