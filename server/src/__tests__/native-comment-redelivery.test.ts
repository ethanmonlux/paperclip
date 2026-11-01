import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { createPostgresWakeQueueAdapter } from "../modules/wake-queue/adapters/postgres.js";
import { createReleaseIssueExecution } from "../modules/wake-queue/application/use-cases.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// FAC-760 stage 13 (per-comment deferred redelivery; receipts b7562a19,
// af0468e2, b16477e2, 26765838). A comment wake deferred behind the
// assignee's execution was promoted after that execution ended, although the
// run that had just finished was started with that exact comment in its
// persisted execution envelope. Native STA-21 records: run 429cd3b9 started
// at 23:50:19 with Coordinator comment 8aef0bde (23:49:51) delivered; after
// it finished, the separate deferred wake for 8aef0bde became run cf9151ec,
// which found nothing new. The same shape produced 1488ecb9 and 722d1f74, and
// runs 62ee5a38, 06feabf2 and da4f94c6 replayed one comment each after run
// 8507d192 had read all of them.
//
// These cases drive the real wake-queue release against Postgres. The
// finishing run's `contextSnapshot.executionContinuation.messages` is the
// envelope the heartbeat persisted when it started that run.

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping native comment redelivery tests on this host: ${support.reason ?? "unsupported environment"}`);
}

type Comment = typeof issueComments.$inferSelect;

describeEmbedded("deferred comment wakes already delivered to the finishing run", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-comment-redelivery-");
    db = createDb(temporary.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  const at = (base: Date, seconds: number) => new Date(base.getTime() + seconds * 1000);

  /** A fresh adapter instance per call models a separate process (restart). */
  function release(companyId: string, runId: string, options: { suppressImmediateRecovery?: boolean } = {}) {
    const releaseIssueExecution = createReleaseIssueExecution({
      issueLock: createPostgresWakeQueueAdapter(db, {
        resolveResponsibleUserId: async () => "responsible-user",
        getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
        resolveSessionBeforeForWakeup: async () => null,
      }),
      recovery: { escalateStrandedAssignedIssue: async () => {}, escalateStrandedRecoveryIssueInPlace: async () => {} },
    });
    return releaseIssueExecution({ companyId, runId, now: new Date(), ...options });
  }

  /** The envelope entry the heartbeat persists for one delivered comment. */
  const delivered = (comment: Comment) => ({
    id: comment.id,
    authorType: comment.authorUserId ? "user" : "agent",
    authorId: comment.authorUserId ?? comment.authorAgentId,
    createdByRunId: comment.createdByRunId,
    body: comment.body,
    createdAt: comment.createdAt.toISOString(),
    updatedAt: comment.updatedAt.toISOString(),
    deleted: comment.deletedAt !== null,
    sourceTrust: comment.sourceTrust ?? null,
  });

  async function fixture() {
    const companyId = randomUUID(), engineerId = randomUUID(), coordinatorId = randomUUID(), issueId = randomUUID();
    const t0 = new Date(Date.now() - 30 * 60_000);
    await db.insert(companies).values({
      id: companyId, name: "Comment redelivery fixture", issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values([
      { id: engineerId, companyId, name: "Engineer", role: "engineer", status: "idle", adapterType: "codex_local",
        runtimeConfig: { heartbeat: { wakeOnDemand: true } } },
      { id: coordinatorId, companyId, name: "Coordinator", role: "engineer", status: "idle", adapterType: "codex_local",
        runtimeConfig: { heartbeat: { wakeOnDemand: true } } },
    ]);
    await db.insert(issues).values({
      id: issueId, companyId, title: "Source task", status: "in_review",
      assigneeAgentId: engineerId, responsibleUserId: "responsible-user",
    });

    async function comment(offsetSeconds: number, author: { userId?: string; agentId?: string; runId?: string }, body: string) {
      const [row] = await db.insert(issueComments).values({
        companyId, issueId, body,
        authorUserId: author.userId ?? null, authorAgentId: author.agentId ?? null, createdByRunId: author.runId ?? null,
        createdAt: at(t0, offsetSeconds), updatedAt: at(t0, offsetSeconds),
      }).returning();
      return row!;
    }

    /** An Engineer run holding the task, started with `envelope` delivered. */
    async function engineerRun(offsetSeconds: number, envelope: Comment[], options: { issueId?: string; wakeupRequestId?: string } = {}) {
      const runId = randomUUID();
      const runIssueId = options.issueId ?? issueId;
      await db.insert(heartbeatRuns).values({
        id: runId, companyId, agentId: engineerId, invocationSource: "automation", status: "running",
        wakeupRequestId: options.wakeupRequestId ?? null,
        runtimeMode: "legacy", startedAt: at(t0, offsetSeconds), createdAt: at(t0, offsetSeconds),
        contextSnapshot: {
          issueId: runIssueId, taskId: runIssueId,
          executionContinuation: {
            version: 1, companyId, issueId: runIssueId,
            messages: envelope.map(delivered),
            coverage: { kind: "full_task_history", throughCommentId: envelope.at(-1)?.id ?? null, summaryThroughCommentId: null },
          },
        },
      });
      await db.update(issues).set({ executionRunId: runId, executionLockedAt: at(t0, offsetSeconds) }).where(eq(issues.id, issueId));
      return runId;
    }
    const finish = (runId: string, status: "succeeded" | "failed" | "cancelled" = "succeeded") =>
      db.update(heartbeatRuns).set({ status, finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));

    /** An `issue_commented` wake deferred behind the Engineer's execution, as the comment route queues it. */
    async function deferredCommentWake(offsetSeconds: number, comments: Comment[], options: {
      agentId?: string; actor?: { type: "user" | "agent"; id: string }; context?: Record<string, unknown>;
    } = {}) {
      const wakeId = randomUUID();
      const ids = comments.map((row) => row.id);
      const latest = ids.at(-1)!;
      const actor = options.actor ?? { type: "agent" as const, id: coordinatorId };
      await db.insert(agentWakeupRequests).values({
        id: wakeId, companyId, agentId: options.agentId ?? engineerId, source: "automation", triggerDetail: "system",
        reason: "issue_commented", status: "deferred_issue_execution",
        requestedByActorType: actor.type, requestedByActorId: actor.id,
        payload: {
          issueId, commentId: latest, mutation: "comment",
          _paperclipWakeContext: {
            issueId, taskId: issueId, commentId: latest, wakeCommentId: latest, wakeCommentIds: ids,
            wakeReason: "issue_commented", source: "issue.comment", ...options.context,
          },
        },
        requestedAt: at(t0, offsetSeconds), createdAt: at(t0, offsetSeconds), updatedAt: at(t0, offsetSeconds),
      });
      return wakeId;
    }

    const wake = (wakeId: string) =>
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)).then((rows) => rows[0]!);
    const queuedRunsFor = (agentId: string) => db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "queued"),
    ));
    const promotedCommentIds = (wakeRow: typeof agentWakeupRequests.$inferSelect) =>
      ((wakeRow.payload as Record<string, unknown>)?._paperclipWakeContext as { wakeCommentIds?: string[] } | undefined)
        ?.wakeCommentIds ?? [];
    return {
      companyId, engineerId, coordinatorId, issueId, t0,
      comment, engineerRun, finish, deferredCommentWake, wake, queuedRunsFor, promotedCommentIds,
    };
  }

  describe("redundant replay", () => {
    it("retires a deferred comment wake whose comment the finishing run was started with (STA-21 429cd3b9 -> cf9151ec)", async () => {
      const f = await fixture();
      const coordinatorComment = await f.comment(10, { agentId: f.coordinatorId }, "Stage authorized.");
      const commentWake = await f.deferredCommentWake(10, [coordinatorComment]);
      const runId = await f.engineerRun(30, [coordinatorComment]);
      await f.finish(runId);

      const result = await release(f.companyId, runId);

      expect(result.outcome.kind).not.toBe("promoted");
      expect(await f.queuedRunsFor(f.engineerId)).toHaveLength(0);
      const retired = await f.wake(commentWake);
      expect(retired.status).toBe("cancelled");
      expect(retired.runId).toBeNull();
      expect(retired.error).toContain("already delivered");
    });

    it("replays comments that arrived during a run once, then retires the remaining per-actor wakes (8507d192 -> 62ee5a38/06feabf2/da4f94c6)", async () => {
      const f = await fixture();
      const founderId = "founder-user";
      // Run 1 starts before any of these comments exist.
      const run1 = await f.engineerRun(0, []);
      const founderOne = await f.comment(20, { userId: founderId }, "Founder priority.");
      const coordinatorNote = await f.comment(25, { agentId: f.coordinatorId }, "Next stage spec.");
      const founderTwo = await f.comment(30, { userId: founderId }, "Additional observation.");
      const founderWake = await f.deferredCommentWake(20, [founderOne, founderTwo], { actor: { type: "user", id: founderId } });
      const coordinatorWake = await f.deferredCommentWake(25, [coordinatorNote]);
      await f.finish(run1);

      // The first replay is genuine: run 1 never saw these comments.
      const first = await release(f.companyId, run1);
      expect(first.outcome.kind).toBe("promoted");
      const promoted = (await f.queuedRunsFor(f.engineerId));
      expect(promoted).toHaveLength(1);

      // That replay run starts with every comment delivered, then finishes.
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, promoted[0]!.id));
      const run2 = await f.engineerRun(60, [founderOne, coordinatorNote, founderTwo]);
      await f.finish(run2);
      const pendingAfterFirst = [founderWake, coordinatorWake];
      const stillDeferred = (await Promise.all(pendingAfterFirst.map(f.wake)))
        .filter((row) => row.status === "deferred_issue_execution");
      expect(stillDeferred).toHaveLength(1);

      // A separate process releases run 2: no further replay.
      const second = await release(f.companyId, run2);
      expect(second.outcome.kind).not.toBe("promoted");
      expect(await f.queuedRunsFor(f.engineerId)).toHaveLength(0);
      expect((await f.wake(stillDeferred[0]!.id)).status).toBe("cancelled");
    });

    it("keeps only the undelivered comments of a partly delivered wake and promotes it", async () => {
      const f = await fixture();
      const seen = await f.comment(10, { agentId: f.coordinatorId }, "Seen before the run.");
      const runId = await f.engineerRun(20, [seen]);
      const late = await f.comment(40, { agentId: f.coordinatorId }, "Arrived during the run.");
      const commentWake = await f.deferredCommentWake(10, [seen, late]);
      await f.finish(runId);

      const result = await release(f.companyId, runId);

      expect(result.outcome.kind).toBe("promoted");
      expect(f.promotedCommentIds(await f.wake(commentWake))).toEqual([late.id]);
    });
  });

  describe("negative controls", () => {
    it("promotes a comment the finishing run was not started with", async () => {
      const f = await fixture();
      const runId = await f.engineerRun(0, []);
      const late = await f.comment(20, { agentId: f.coordinatorId }, "Arrived during the run.");
      const commentWake = await f.deferredCommentWake(20, [late]);
      await f.finish(runId);

      const result = await release(f.companyId, runId);

      expect(result.outcome.kind).toBe("promoted");
      expect((await f.wake(commentWake)).status).not.toBe("deferred_issue_execution");
      expect(await f.queuedRunsFor(f.engineerId)).toHaveLength(1);
    });

    it("promotes a delivered comment when the finishing run failed before provider work", async () => {
      const f = await fixture();
      const seen = await f.comment(10, { agentId: f.coordinatorId }, "Seen before the run.");
      const commentWake = await f.deferredCommentWake(10, [seen]);
      const runId = await f.engineerRun(20, [seen]);
      await f.finish(runId, "failed");
      await db.update(heartbeatRuns).set({ resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } })
        .where(eq(heartbeatRuns.id, runId));

      const result = await release(f.companyId, runId, { suppressImmediateRecovery: true });

      expect(result.outcome.kind).toBe("promoted");
      expect(f.promotedCommentIds(await f.wake(commentWake))).toEqual([seen.id]);
    });

    it("never retires a delivered comment's wake on a cancelled finishing run", async () => {
      const f = await fixture();
      const seen = await f.comment(10, { agentId: f.coordinatorId }, "Seen before the run.");
      const commentWake = await f.deferredCommentWake(10, [seen]);
      const runId = await f.engineerRun(20, [seen]);
      await f.finish(runId, "cancelled");

      await release(f.companyId, runId);

      expect((await f.wake(commentWake)).error ?? "").not.toContain("already delivered");
    });

    it("promotes a delivered comment that was edited after the run started", async () => {
      const f = await fixture();
      const seen = await f.comment(10, { agentId: f.coordinatorId }, "Original text.");
      const commentWake = await f.deferredCommentWake(10, [seen]);
      const runId = await f.engineerRun(20, [seen]);
      await db.update(issueComments).set({ body: "Edited text.", updatedAt: at(f.t0, 40) }).where(eq(issueComments.id, seen.id));
      await f.finish(runId);

      const result = await release(f.companyId, runId);

      expect(result.outcome.kind).toBe("promoted");
      expect(f.promotedCommentIds(await f.wake(commentWake))).toEqual([seen.id]);
    });

    it("promotes a comment written after the run started, even when the run's envelope was built later and lists it", async () => {
      const f = await fixture();
      // The run was admitted at 20s; its envelope was assembled after the comment at 25s landed.
      const late = await f.comment(25, { userId: "founder-user" }, "Follow-up after the run started.");
      const commentWake = await f.deferredCommentWake(25, [late], { actor: { type: "user", id: "founder-user" } });
      const runId = await f.engineerRun(20, [late]);
      await f.finish(runId);

      const result = await release(f.companyId, runId);

      expect(result.outcome.kind).toBe("promoted");
      expect(f.promotedCommentIds(await f.wake(commentWake))).toEqual([late.id]);
    });

    it("keeps an interaction continuation's delivered source comment", async () => {
      const f = await fixture();
      const source = await f.comment(10, { userId: "founder-user" }, "Accepted with this direction.");
      const continuation = await f.deferredCommentWake(10, [source], {
        actor: { type: "user", id: "founder-user" },
        context: { interactionId: randomUUID(), interactionKind: "request_confirmation", interactionStatus: "accepted",
          sourceCommentId: source.id, source: "issue.interaction.respond" },
      });
      const runId = await f.engineerRun(20, [source]);
      await f.finish(runId);

      const result = await release(f.companyId, runId);

      expect(result.outcome.kind).toBe("promoted");
      expect(f.promotedCommentIds(await f.wake(continuation))).toEqual([source.id]);
    });

    it("ignores an envelope recorded for a different task", async () => {
      const f = await fixture();
      const seen = await f.comment(10, { agentId: f.coordinatorId }, "Seen before the run.");
      const commentWake = await f.deferredCommentWake(10, [seen]);
      const runId = await f.engineerRun(20, [seen], { issueId: randomUUID() });
      await f.finish(runId);

      await release(f.companyId, runId);

      expect((await f.wake(commentWake)).status).not.toBe("cancelled");
    });

    it("keeps a delivered comment wake that carries an explicit resume intent", async () => {
      const f = await fixture();
      const seen = await f.comment(10, { agentId: f.coordinatorId }, "Resume after review.");
      const commentWake = await f.deferredCommentWake(10, [seen], { context: { resumeIntent: true } });
      const runId = await f.engineerRun(20, [seen]);
      await f.finish(runId);

      const result = await release(f.companyId, runId);

      expect(result.outcome.kind).toBe("promoted");
      expect((await f.wake(commentWake)).status).not.toBe("cancelled");
    });

    it("leaves a delivered comment's wake for another agent to that agent's own path", async () => {
      const f = await fixture();
      const seen = await f.comment(10, { userId: "founder-user" }, "Coordinator, please route.");
      const coordinatorWake = await f.deferredCommentWake(10, [seen], {
        agentId: f.coordinatorId, actor: { type: "user", id: "founder-user" },
      });
      const runId = await f.engineerRun(20, [seen]);
      await f.finish(runId);
      const before = await f.wake(coordinatorWake);

      await release(f.companyId, runId);

      const after = await f.wake(coordinatorWake);
      // Never retired as "already delivered": the Engineer's envelope is not the Coordinator's.
      expect(after.error ?? "").not.toContain("already delivered");
      expect(before.status).toBe("deferred_issue_execution");
    });
  });

  // A queued-comment interrupt ("send these queued messages now") cancels the
  // running turn and dispatches exactly the selected queue. That turn's
  // envelope still carries the whole task history, so another actor's queued
  // comment is in it, but the interrupt contract owes that queue its own turn
  // once the requested turn completes (heartbeat-process-recovery "resumes only
  // the authorized pending queue after an acknowledged legacy interrupt"). The
  // typed link is the cancelled run's `resultJson.queuedCommentInterruptQueueId`
  // naming the finishing run's own `wakeupRequestId`.
  describe("authorized queued-comment interrupt turns", () => {
    async function interruptTurn(f: Awaited<ReturnType<typeof fixture>>, options: {
      interruptNames?: "own" | "other"; interruptAgent?: "engineer" | "coordinator";
    } = {}) {
      const selected = await f.comment(10, { userId: "responsible-user" }, "Send this now.");
      const other = await f.comment(11, { userId: "other-user" }, "Other actor's queued input.");
      const selectedWake = await f.deferredCommentWake(10, [selected], { actor: { type: "user", id: "responsible-user" } });
      const otherWake = await f.deferredCommentWake(11, [other], { actor: { type: "user", id: "other-user" } });
      // The interrupted turn, cancelled by the operator's queue interrupt.
      const interruptedRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: interruptedRunId, companyId: f.companyId,
        agentId: options.interruptAgent === "coordinator" ? f.coordinatorId : f.engineerId,
        invocationSource: "automation", status: "cancelled", runtimeMode: "legacy",
        startedAt: at(f.t0, 5), createdAt: at(f.t0, 5), finishedAt: at(f.t0, 15),
        contextSnapshot: { issueId: f.issueId, taskId: f.issueId },
        resultJson: {
          operatorInterrupted: true,
          queuedCommentInterruptQueueId: options.interruptNames === "other" ? randomUUID() : selectedWake,
          executionCancellation: { state: "acknowledged" },
        },
      });
      // The selected queue was promoted into the turn that is now finishing.
      const runId = await f.engineerRun(20, [selected, other], { wakeupRequestId: selectedWake });
      await db.update(agentWakeupRequests).set({ status: "completed", runId }).where(eq(agentWakeupRequests.id, selectedWake));
      await f.finish(runId);
      return { runId, other, otherWake };
    }

    it("still gives another actor's queue its own turn after the requested interrupt turn completes", async () => {
      const f = await fixture();
      const { runId, other, otherWake } = await interruptTurn(f);

      const result = await release(f.companyId, runId);

      expect(result.outcome.kind).toBe("promoted");
      const promoted = await f.wake(otherWake);
      expect(promoted.error ?? "").not.toContain("already delivered");
      expect(promoted.status).not.toBe("cancelled");
      expect(f.promotedCommentIds(promoted)).toEqual([other.id]);
      expect(await f.queuedRunsFor(f.engineerId)).toHaveLength(1);
    });

    it("still retires the delivered queue when the cancelled run's interrupt named a different queue", async () => {
      const f = await fixture();
      const { runId, otherWake } = await interruptTurn(f, { interruptNames: "other" });

      await release(f.companyId, runId);

      const retired = await f.wake(otherWake);
      expect(retired.status).toBe("cancelled");
      expect(retired.error).toContain("already delivered");
      expect(await f.queuedRunsFor(f.engineerId)).toHaveLength(0);
    });

    it("still retires the delivered queue when only another agent's run names the finishing run's wake", async () => {
      const f = await fixture();
      const { runId, otherWake } = await interruptTurn(f, { interruptAgent: "coordinator" });

      await release(f.companyId, runId);

      const retired = await f.wake(otherWake);
      expect(retired.status).toBe("cancelled");
      expect(retired.error).toContain("already delivered");
    });
  });
});
