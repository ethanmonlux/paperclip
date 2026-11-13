import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { mergeGateRoutes } from "../routes/merge-gate.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping merge gate route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

type Db = ReturnType<typeof createDb>;

const dryRun = { repo: "acme/widgets", pullNumber: 730, dryRun: true };

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", mergeGateRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("merge gate routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-merge-gate-routes-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const nonce = randomUUID().slice(0, 4).toUpperCase();
    const prefix = `MG${nonce}`;
    const [company] = await db.insert(companies)
      .values({ name: `Merge gate ${nonce}`, issuePrefix: prefix, defaultResponsibleUserId: "board-user" }).returning();
    const [implementer] = await db.insert(agents)
      .values({ companyId: company!.id, name: "Implementer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {} })
      .returning();
    const [run] = await db.insert(heartbeatRuns)
      .values({ companyId: company!.id, agentId: implementer!.id, status: "running", contextSnapshot: {} }).returning();
    const [issue] = await db.insert(issues)
      .values({ companyId: company!.id, title: "Ship the fix", status: "in_progress", priority: "high",
        identifier: `${prefix}-343`, assigneeAgentId: implementer!.id, responsibleUserId: "board-user" })
      .returning();
    const actor: Express.Request["actor"] = {
      type: "agent", agentId: implementer!.id, companyId: company!.id, runId: run!.id, source: "agent_jwt",
    };
    return { company: company!, issue: issue!, actor, prefix };
  }

  it("evaluates a task addressed by its identifier instead of failing with a 500", async () => {
    const { issue, actor } = await seed();
    const app = createApp(db, actor);

    for (const ref of [issue.identifier!, issue.identifier!.toLowerCase(), issue.id]) {
      const res = await request(app).post(`/api/issues/${ref}/merge-gate`).send(dryRun);
      // The gate reached its authority check for the resolved task: its own
      // implementer is refused, exactly as when the task is addressed by UUID.
      expect(res.status, `${ref}: ${JSON.stringify(res.body)}`).toBe(403);
      expect(res.body.error).toMatch(/implementer cannot merge its own task/);
    }
  });

  it("answers 404 for a path that is neither a task UUID nor an identifier", async () => {
    const { actor, prefix } = await seed();
    const app = createApp(db, actor);

    for (const ref of ["not-a-task", `${prefix}-999`, randomUUID()]) {
      const res = await request(app).post(`/api/issues/${ref}/merge-gate`).send(dryRun);
      expect(res.status, `${ref}: ${JSON.stringify(res.body)}`).toBe(404);
    }
  });

  it("does not resolve another company's task identifier", async () => {
    const { issue } = await seed();
    const other = await seed();
    const app = createApp(db, other.actor);

    const res = await request(app).post(`/api/issues/${issue.identifier}/merge-gate`).send(dryRun);
    expect(res.status).toBe(404);
  });
});
