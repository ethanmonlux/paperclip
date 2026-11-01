import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// FAC-760 stage 13 (STA-33 self-wake loop, receipt 5573fba3). The assignee's
// own run PATCHed its task in_progress -> blocked on a blocker that was
// already Done and named itself as the unblock owner. Both the
// restored-ready-dependency wake and the unblock-owner notification then woke
// that same agent; each re-block stamped a new `blockedTransitionAt`, so
// neither idempotency key ever repeated. Native records: STA-33 runs
// 618733c0 and d720af3f carried wakeReason issue_unblock_requested with
// source issue.blockers_restored, about every two minutes.
//
// These cases drive the real issue PATCH route on Postgres. Only
// `heartbeat.wakeup` is replaced with a recorder, so no provider runs.

const wakeups = vi.hoisted(() => [] as Array<{ agentId: string; reason: string; source?: string }>);

vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  return {
    ...actual,
    heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => {
      const real = actual.heartbeatService(...args);
      return {
        ...real,
        wakeup: async (agentId: string, options: { reason?: string | null; contextSnapshot?: Record<string, unknown> }) => {
          wakeups.push({
            agentId,
            reason: options.reason ?? "",
            source: typeof options.contextSnapshot?.source === "string" ? options.contextSnapshot.source : undefined,
          });
          return null;
        },
      };
    },
  };
});

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping native self-wake route tests on this host: ${support.reason ?? "unsupported environment"}`);
}

describeEmbedded("assignee self-wake on a self-written blocked transition (STA-33)", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let createApp: (actor: Express.Request["actor"]) => express.Express;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-self-wake-routes-");
    db = createDb(temporary.connectionString);
    const [{ issueRoutes }, { errorHandler }] = await Promise.all([
      import("../routes/issues.js"),
      import("../middleware/index.js"),
    ]);
    createApp = (actor) => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = actor;
        next();
      });
      app.use("/api", issueRoutes(db, {} as any));
      app.use(errorHandler);
      return app;
    };
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });
  beforeEach(() => {
    wakeups.length = 0;
  });

  async function fixture() {
    const companyId = randomUUID(), assigneeId = randomUUID(), otherAgentId = randomUUID();
    const issueId = randomUUID(), blockerId = randomUUID(), runId = randomUUID(), otherRunId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Self-wake fixture", issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(authUsers).values({ id: "board-user", name: "Board", email: "board@example.test", createdAt: new Date(), updatedAt: new Date() })
      .onConflictDoNothing();
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: "board-user", status: "active", membershipRole: "admin",
    });
    await db.insert(agents).values([
      { id: assigneeId, companyId, name: "Portfolio Coordinator", role: "engineer", status: "active", adapterType: "codex_local",
        adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: otherAgentId, companyId, name: "Workflow Coordinator", role: "engineer", status: "active", adapterType: "codex_local",
        adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Done blocker", status: "done", priority: "medium", completedAt: new Date(Date.now() - 3_600_000) },
      { id: issueId, companyId, title: "Product acceptance hold", status: "in_progress", priority: "high", assigneeAgentId: assigneeId },
    ]);
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });
    await db.insert(heartbeatRuns).values([
      { id: runId, companyId, agentId: assigneeId, status: "running", invocationSource: "automation",
        startedAt: new Date(), contextSnapshot: { issueId } },
      { id: otherRunId, companyId, agentId: otherAgentId, status: "running", invocationSource: "automation",
        startedAt: new Date(), contextSnapshot: { issueId } },
    ]);
    // The assignee's run holds the task, as STA-33's runs did when they re-blocked it.
    await db.update(issues).set({ checkoutRunId: runId, executionRunId: runId, executionLockedAt: new Date() })
      .where(eq(issues.id, issueId));

    const agentActor = (agentId: string): Express.Request["actor"] => ({
      type: "agent", agentId, companyId, runId: agentId === assigneeId ? runId : otherRunId, source: "agent_jwt",
    });
    const boardActor: Express.Request["actor"] = {
      type: "board", userId: "board-user", companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }], isInstanceAdmin: false, source: "session",
    };
    const block = async (actor: Express.Request["actor"], body: Record<string, unknown>) => {
      const res = await request(createApp(actor)).patch(`/api/issues/${issueId}`).send(body);
      // Wake scheduling can run after the response; let it settle.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      return res;
    };
    const issue = () => db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    return { companyId, assigneeId, otherAgentId, issueId, blockerId, runId, agentActor, boardActor, block, issue };
  }

  const reasonsFor = (agentId: string) => wakeups.filter((wake) => wake.agentId === agentId).map((wake) => wake.reason);
  const descriptor = (owner: { agentId: string } | "board") => ({
    owner, action: "Reconcile founder physical evidence when it arrives.",
  });

  it("does not wake the assignee whose own run blocked its task on a Done blocker and named itself owner (STA-33)", async () => {
    const f = await fixture();
    const res = await f.block(f.agentActor(f.assigneeId), {
      status: "blocked", blockedByIssueIds: [f.blockerId], unblockDescriptor: descriptor({ agentId: f.assigneeId }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await f.issue()).status).toBe("blocked");
    expect(reasonsFor(f.assigneeId)).toEqual([]);
  });

  it("does not wake the assignee through the restored-dependency path when its own run edits blockers on its blocked task", async () => {
    const f = await fixture();
    // Already blocked on its own unblock action (owner notified for that cycle).
    await db.update(issues).set({ status: "blocked", blockedTransitionAt: new Date(), blockedOwnerNotifiedAt: new Date(),
      unblockDescriptor: descriptor({ agentId: f.assigneeId }) }).where(eq(issues.id, f.issueId));
    const res = await f.block(f.agentActor(f.assigneeId), { blockedByIssueIds: [f.blockerId] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await f.issue()).status).toBe("blocked");
    expect(reasonsFor(f.assigneeId)).toEqual([]);
  });

  it("stays quiet across repeated self re-blocks, each with a new blocked transition", async () => {
    const f = await fixture();
    for (let round = 0; round < 3; round += 1) {
      await db.update(issues).set({ status: "in_progress", checkoutRunId: f.runId, executionRunId: f.runId,
        blockedTransitionAt: null, blockedOwnerNotifiedAt: null, unblockDescriptor: null })
        .where(eq(issues.id, f.issueId));
      const res = await f.block(f.agentActor(f.assigneeId), {
        status: "blocked", blockedByIssueIds: [f.blockerId], unblockDescriptor: descriptor({ agentId: f.assigneeId }),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    expect(reasonsFor(f.assigneeId)).toEqual([]);
  });

  describe("negative controls", () => {
    it("still wakes the assignee when the board blocks its task on a Done blocker", async () => {
      const f = await fixture();
      const res = await f.block(f.boardActor, {
        status: "blocked", blockedByIssueIds: [f.blockerId], unblockDescriptor: descriptor("board"),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(reasonsFor(f.assigneeId)).toContain("issue_blockers_resolved");
    });

    it("still notifies the assignee named as unblock owner when the board blocks its task", async () => {
      const f = await fixture();
      const res = await f.block(f.boardActor, {
        status: "blocked", blockedByIssueIds: [f.blockerId], unblockDescriptor: descriptor({ agentId: f.assigneeId }),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(reasonsFor(f.assigneeId)).toContain("issue_unblock_requested");
    });

    it("still wakes the assignee when another agent blocks its task, without notifying that writing agent", async () => {
      const f = await fixture();
      // The assignee's run has released the task back to todo, so another agent may write it.
      await db.update(issues).set({ status: "todo", checkoutRunId: null, executionRunId: null, executionLockedAt: null })
        .where(eq(issues.id, f.issueId));
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
      const res = await f.block(f.agentActor(f.otherAgentId), {
        status: "blocked", blockedByIssueIds: [f.blockerId], unblockDescriptor: descriptor({ agentId: f.otherAgentId }),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(reasonsFor(f.assigneeId)).toContain("issue_blockers_resolved");
      // The writer named itself owner; it already holds the unblock action.
      expect(reasonsFor(f.otherAgentId)).toEqual([]);
    });

    it("still wakes a dependent's assignee when its blocker becomes Done", async () => {
      const f = await fixture();
      // The dependent waits on an open blocker that the other agent then completes.
      await db.update(issues).set({ status: "in_progress", assigneeAgentId: f.otherAgentId,
        checkoutRunId: null, executionRunId: null, executionLockedAt: null })
        .where(eq(issues.id, f.blockerId));
      await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.blockerId } })
        .where(eq(heartbeatRuns.agentId, f.otherAgentId));
      await db.update(issues).set({ status: "blocked", checkoutRunId: null, executionRunId: null, executionLockedAt: null,
        blockedTransitionAt: new Date(), unblockDescriptor: descriptor({ agentId: f.assigneeId }) })
        .where(eq(issues.id, f.issueId));
      const res = await request(createApp(f.agentActor(f.otherAgentId)))
        .patch(`/api/issues/${f.blockerId}`).send({ status: "done" });
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(reasonsFor(f.assigneeId)).toContain("issue_blockers_resolved");
    });
  });
});
