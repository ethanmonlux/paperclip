import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.js";
import { recoveryService } from "../services/recovery/service.js";
import { buildContinuationSummaryMarkdown } from "../services/issue-continuation-summary.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// FAC-760 STA-22 round 8: a Coordinator reopened a Done review task for a new
// exact-head round. The next run the reviewer received was a disposition repair
// of the previous stage's run, which had recorded Done. These cases pin the
// typed stage boundary that must keep a fresh stage from inheriting that run.

const STALE_REVIEW_SUMMARY = [
  "# Continuation Summary",
  "",
  "- Status: in_review",
  "",
  "## Next Action",
  "",
  "- Wait for reviewer feedback or approval before continuing executor work.",
].join("\n");

describe("native task-bound continuation across stages", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-task-bound-continuation-");
    db = createDb(temporary.connectionString);
  }, 20_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  const at = (base: Date, seconds: number) => new Date(base.getTime() + seconds * 1000);

  async function fixture(input: { recordedStatus: string | null; reopenAfterRun: boolean }) {
    const companyId = randomUUID(), agentId = randomUUID(), coordinatorId = randomUUID();
    const issueId = randomUUID(), runId = randomUUID();
    const t0 = new Date(Date.now() - 30 * 60_000);
    await db.insert(companies).values({ id: companyId, name: "Stage fixture", issuePrefix: `S${companyId.slice(0, 6)}`, defaultResponsibleUserId: "fixture-owner" });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Reviewer", role: "engineer", status: "idle", adapterType: "codex_local", runtimeConfig: { heartbeat: { wakeOnDemand: true } } },
      { id: coordinatorId, companyId, name: "Coordinator", role: "engineer", status: "idle", adapterType: "codex_local", runtimeConfig: { heartbeat: { wakeOnDemand: false } } },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Review exact head", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: "fixture-owner", startedAt: at(t0, -600) });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, invocationSource: "automation", status: "succeeded", runtimeMode: "legacy",
      startedAt: at(t0, -300), finishedAt: t0, createdAt: at(t0, -300),
      contextSnapshot: { issueId, wakeReason: "issue_commented" }, livenessState: "advanced",
      resultJson: { summary: "Verdict recorded." },
    });
    // The prior stage's verdict and the previous run's recorded disposition.
    await db.insert(issueComments).values({ companyId, issueId, authorAgentId: agentId, createdByRunId: runId, body: "BLOCK: finding R6 retained." });
    if (input.recordedStatus) {
      await db.insert(activityLog).values({
        companyId, actorType: "agent", actorId: agentId, agentId, runId, action: "issue.updated", entityType: "issue", entityId: issueId,
        details: { status: input.recordedStatus, changes: { status: { from: "in_progress", to: input.recordedStatus } } },
        createdAt: at(t0, -5),
      });
    }
    if (input.reopenAfterRun) {
      // A different actor opens the next stage on the same retained task.
      await db.insert(issueComments).values({ companyId, issueId, authorAgentId: coordinatorId, body: "Round 8: review exact head b4c87d9b." });
      await db.insert(activityLog).values({
        companyId, actorType: "agent", actorId: coordinatorId, agentId: coordinatorId, runId: null, action: "issue.updated", entityType: "issue", entityId: issueId,
        details: { status: "in_progress", changes: { status: { from: input.recordedStatus ?? "in_progress", to: "in_progress" } } },
        createdAt: at(t0, 60),
      });
      await db.update(issues).set({ startedAt: at(t0, 60) }).where(eq(issues.id, issueId));
    }
    const createRecovery = () => recoveryService(db, {
      enqueueWakeup: async (targetAgentId, opts) => db.transaction(async tx => {
        const [wake] = await tx.insert(agentWakeupRequests).values({ companyId, agentId: targetAgentId, source: "automation", reason: opts?.reason, payload: opts?.payload, idempotencyKey: opts?.idempotencyKey, status: "queued" }).returning();
        const [run] = await tx.insert(heartbeatRuns).values({ companyId, agentId: targetAgentId, invocationSource: "automation", status: "queued", runtimeMode: "legacy", wakeupRequestId: wake.id, contextSnapshot: opts?.contextSnapshot }).returning();
        await tx.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, wake.id));
        return run;
      }),
    });
    const runs = () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    // The sweep visits every fixture in this database; keep only this task's runs.
    const successors = async () => (await runs()).filter(r => r.id !== runId && (r.contextSnapshot as Record<string, unknown> | null)?.issueId === issueId);
    const actions = () => db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId));
    return { companyId, agentId, coordinatorId, issueId, runId, t0, createRecovery, runs, successors, actions };
  }

  const isDispositionRepair = (run: typeof heartbeatRuns.$inferSelect) => {
    const context = (run.contextSnapshot ?? {}) as Record<string, unknown>;
    return context.wakeReason === "issue_disposition_repair" || Boolean(context.legacyDispositionEpisode) || Boolean(context.dispositionRepairInstruction);
  };

  describe("previous-stage disposition repair", () => {
    it.each(["done", "in_review", "blocked"])(
      "does not repair a previous stage run that recorded %s once another actor opens a new stage",
      async recordedStatus => {
        const f = await fixture({ recordedStatus, reopenAfterRun: true });
        expect(await f.createRecovery().reconcileLegacyContinuation(f.runId)).toBe("skipped");
        expect((await f.successors()).filter(isDispositionRepair)).toEqual([]);
        expect((await f.actions()).filter(a => a.kind === "deliberate_wait_without_target")).toEqual([]);
      },
    );

    it("gives the new stage an ordinary task-bound continuation through the sweep, retaining prior findings", async () => {
      const f = await fixture({ recordedStatus: "done", reopenAfterRun: true });
      await f.createRecovery().reconcileStrandedAssignedIssues();
      const successors = await f.successors();
      expect(successors.filter(isDispositionRepair)).toEqual([]);
      expect(successors).toHaveLength(1);
      expect(successors[0]).toMatchObject({ agentId: f.agentId, status: "queued" });
      expect(successors[0].contextSnapshot).toMatchObject({ issueId: f.issueId, wakeReason: "issue_continuation_needed" });
      expect((await f.actions()).filter(a => a.kind === "deliberate_wait_without_target")).toEqual([]);
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
      expect(comments.map(c => c.body)).toContain("BLOCK: finding R6 retained.");
    });

    it("keeps the new stage on an ordinary path across repeated reopen rounds", async () => {
      const f = await fixture({ recordedStatus: "done", reopenAfterRun: true });
      for (let round = 0; round < 3; round += 1) {
        await f.createRecovery().reconcileStrandedAssignedIssues();
        const queued = (await f.successors()).filter(r => r.status === "queued");
        expect(queued).toHaveLength(1);
        expect(isDispositionRepair(queued[0])).toBe(false);
        // The stage's run records Done; a new actor reopens the next round.
        const finishedAt = new Date();
        await db.update(heartbeatRuns).set({ status: "succeeded", livenessState: "advanced", startedAt: at(finishedAt, -2), finishedAt }).where(eq(heartbeatRuns.id, queued[0].id));
        await db.update(agentWakeupRequests).set({ status: "completed" }).where(eq(agentWakeupRequests.runId, queued[0].id));
        await db.insert(activityLog).values([
          { companyId: f.companyId, actorType: "agent", actorId: f.agentId, agentId: f.agentId, runId: queued[0].id, action: "issue.updated", entityType: "issue", entityId: f.issueId,
            details: { status: "done", changes: { status: { from: "in_progress", to: "done" } } }, createdAt: at(finishedAt, -1) },
          { companyId: f.companyId, actorType: "agent", actorId: f.coordinatorId, agentId: f.coordinatorId, action: "issue.updated", entityType: "issue", entityId: f.issueId,
            details: { status: "in_progress", changes: { status: { from: "done", to: "in_progress" } } }, createdAt: at(finishedAt, 1) },
        ]);
      }
      expect((await f.successors()).filter(isDispositionRepair)).toEqual([]);
    });

    it("still repairs a run that left its own stage active without a disposition", async () => {
      const f = await fixture({ recordedStatus: null, reopenAfterRun: false });
      expect(await f.createRecovery().reconcileLegacyContinuation(f.runId)).toBe("queued");
      expect((await f.successors()).filter(isDispositionRepair)).toHaveLength(1);
    });

    it("still repairs a run whose own last recorded status was in_progress, even after a later no-op status write", async () => {
      const f = await fixture({ recordedStatus: "in_progress", reopenAfterRun: true });
      expect(await f.createRecovery().reconcileLegacyContinuation(f.runId)).toBe("queued");
    });

    it("keeps a genuine pending human question parked for the new stage", async () => {
      const f = await fixture({ recordedStatus: "done", reopenAfterRun: true });
      await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId, kind: "request_confirmation", status: "pending", requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only", payload: { version: 1, prompt: "Approve the next round?" } });
      await f.createRecovery().reconcileStrandedAssignedIssues();
      expect(await f.successors()).toEqual([]);
    });

    it("cancels an already-queued previous-stage repair before dispatch once a new stage opens", async () => {
      const f = await fixture({ recordedStatus: null, reopenAfterRun: false });
      await f.createRecovery().reconcileLegacyContinuation(f.runId);
      const [repair] = (await f.successors()).filter(isDispositionRepair);
      expect(repair).toBeDefined();
      // The previous run is now seen to have recorded Done, and a new stage opened.
      await db.insert(activityLog).values([
        { companyId: f.companyId, actorType: "agent", actorId: f.agentId, agentId: f.agentId, runId: f.runId, action: "issue.updated", entityType: "issue", entityId: f.issueId,
          details: { status: "done", changes: { status: { from: "in_progress", to: "done" } } }, createdAt: at(f.t0, -1) },
        { companyId: f.companyId, actorType: "agent", actorId: f.coordinatorId, agentId: f.coordinatorId, action: "issue.updated", entityType: "issue", entityId: f.issueId,
          details: { status: "in_progress", changes: { status: { from: "done", to: "in_progress" } } }, createdAt: at(f.t0, 120) },
      ]);
      expect(await f.createRecovery().legacyRepairDispatchBlock(repair.id)).toBe("newer_stage");
      // The stale agent-owned repair notice is reconciled, not left active.
      await f.createRecovery().reconcileStrandedAssignedIssues();
      expect((await f.actions()).filter(a => a.status === "active" && a.kind === "deliberate_wait_without_target")).toEqual([]);
    });
  });

  describe("previous-stage continuation summary", () => {
    async function seedSummary(companyId: string, issueId: string, agentId: string, body: string, updatedAt: Date, createdByRunId: string | null = null) {
      const documentId = randomUUID(), revisionId = randomUUID();
      await db.insert(documents).values({ id: documentId, companyId, title: "Continuation Summary", format: "markdown", latestBody: body, latestRevisionId: revisionId, latestRevisionNumber: 1, createdByAgentId: agentId, updatedByAgentId: agentId, updatedAt, createdAt: updatedAt });
      await db.insert(documentRevisions).values({ id: revisionId, companyId, documentId, revisionNumber: 1, title: "Continuation Summary", format: "markdown", body, createdByAgentId: agentId, createdByRunId, createdAt: updatedAt });
      await db.insert(issueDocuments).values({ companyId, issueId, documentId, key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY });
    }
    async function queueContinuation(companyId: string, agentId: string, issueId: string, extraContext: Record<string, unknown> = {}) {
      const id = randomUUID();
      await db.insert(heartbeatRuns).values({ id, companyId, agentId, invocationSource: "automation", status: "queued", runtimeMode: "legacy",
        contextSnapshot: { issueId, wakeReason: "issue_continuation_needed", retryReason: "issue_continuation_needed", ...extraContext } });
      return id;
    }

    it("does not let a summary written before the current stage park the fresh assignment", async () => {
      const f = await fixture({ recordedStatus: "in_review", reopenAfterRun: true });
      await seedSummary(f.companyId, f.issueId, f.agentId, STALE_REVIEW_SUMMARY, at(f.t0, 1), f.runId);
      const runId = await queueContinuation(f.companyId, f.agentId, f.issueId);
      expect(await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({ runId, companyId: f.companyId, expectedStatus: "queued", now: new Date() }))
        .toMatchObject({ outcome: "not_stale" });
    });

    it("does not let a queued previous-stage summary snapshot park the fresh assignment", async () => {
      const f = await fixture({ recordedStatus: "in_review", reopenAfterRun: true });
      const runId = await queueContinuation(f.companyId, f.agentId, f.issueId, {
        paperclipContinuationSummary: { body: STALE_REVIEW_SUMMARY, updatedAt: at(f.t0, 1).toISOString() },
      });
      expect(await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({ runId, companyId: f.companyId, expectedStatus: "queued", now: new Date() }))
        .toMatchObject({ outcome: "not_stale" });
    });

    it("still parks on a summary written within the current stage", async () => {
      const f = await fixture({ recordedStatus: "in_review", reopenAfterRun: true });
      await seedSummary(f.companyId, f.issueId, f.agentId, STALE_REVIEW_SUMMARY, at(f.t0, 120));
      const runId = await queueContinuation(f.companyId, f.agentId, f.issueId);
      expect(await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({ runId, companyId: f.companyId, expectedStatus: "queued", now: new Date() }))
        .toMatchObject({ outcome: "cancelled", errorCode: "issue_continuation_waiting_on_review" });
    });

    it("still parks when no status change followed the summary", async () => {
      const f = await fixture({ recordedStatus: null, reopenAfterRun: false });
      await seedSummary(f.companyId, f.issueId, f.agentId, STALE_REVIEW_SUMMARY, at(f.t0, 1), f.runId);
      const runId = await queueContinuation(f.companyId, f.agentId, f.issueId);
      expect(await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({ runId, companyId: f.companyId, expectedStatus: "queued", now: new Date() }))
        .toMatchObject({ outcome: "cancelled", errorCode: "issue_continuation_waiting_on_review" });
    });

    it("ignores a status change made by the run that wrote the summary", async () => {
      const f = await fixture({ recordedStatus: null, reopenAfterRun: false });
      await seedSummary(f.companyId, f.issueId, f.agentId, STALE_REVIEW_SUMMARY, at(f.t0, 1), f.runId);
      await db.insert(activityLog).values({ companyId: f.companyId, actorType: "agent", actorId: f.agentId, agentId: f.agentId, runId: f.runId, action: "issue.updated", entityType: "issue", entityId: f.issueId,
        details: { status: "in_progress", changes: { status: { from: "todo", to: "in_progress" } } }, createdAt: at(f.t0, 2) });
      const runId = await queueContinuation(f.companyId, f.agentId, f.issueId);
      expect(await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({ runId, companyId: f.companyId, expectedStatus: "queued", now: new Date() }))
        .toMatchObject({ outcome: "cancelled", errorCode: "issue_continuation_waiting_on_review" });
    });
  });

  describe("summary generation", () => {
    const base = {
      issue: { id: "issue-1", identifier: "STA-22", title: "Review", description: null, status: "in_progress", priority: "high" },
      run: { id: "run-2", status: "succeeded", error: null },
      agent: { id: "agent-1", name: "Reviewer", adapterType: "codex_local" },
    };
    const nextAction = (body: string) => body.split("## Next Action")[1]?.trim();

    it.each([
      "Wait for reviewer feedback or approval before continuing executor work.",
      "Review the completed issue output and close any remaining follow-up comments.",
    ])("does not carry a generated status-specific next action (%s) into a different status", previous => {
      const body = buildContinuationSummaryMarkdown({ ...base, previousSummaryBody: `## Next Action\n\n- ${previous}` });
      expect(nextAction(body)).not.toContain(previous);
    });

    it("still carries an owner-written next action forward", () => {
      const body = buildContinuationSummaryMarkdown({ ...base, previousSummaryBody: "## Next Action\n\n- Rerun the migration probe on the private copy." });
      expect(nextAction(body)).toContain("Rerun the migration probe on the private copy.");
    });
  });
});
