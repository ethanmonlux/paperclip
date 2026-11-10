import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueAccessGrants,
  issueComments,
  issueExecutionDecisions,
  issueRelations,
  issueWorkProducts,
  issues,
  projectAccessMembers,
  projects,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
} from "@paperclipai/db";
import type { StapleConsoleBoard } from "@paperclipai/shared/staple-console";
import type { AuthorizationActor } from "../services/authorization.js";
import { stapleConsoleService } from "../services/staple-console.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

const cards = (board: StapleConsoleBoard) => board.lanes.flatMap((lane) => lane.cards);
const boardText = (board: StapleConsoleBoard) => JSON.stringify(board);

suite("staple console service", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("staple-console-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Staple", issuePrefix: `S${companyId.slice(0, 6).toUpperCase()}` });
    return companyId;
  }

  it("omits open tasks in a private project or under private ancestry unless the actor may read them", async () => {
    const companyId = await seedCompany();
    const outsider = randomUUID();
    const reader = randomUUID();
    const [project] = await db.insert(projects).values({ companyId, name: "Private project", visibility: "private" }).returning();
    const [publicTask] = await db.insert(issues).values({
      companyId, title: "Public console task", status: "todo", createdByUserId: "someone-else",
    }).returning();
    const [projectTask] = await db.insert(issues).values({
      companyId, title: "Secret project task", status: "in_progress", projectId: project!.id, createdByUserId: "someone-else",
    }).returning();
    const [privateRoot] = await db.insert(issues).values({
      companyId, title: "Secret private root", status: "todo", visibility: "private", createdByUserId: "someone-else",
    }).returning();
    const [descendant] = await db.insert(issues).values({
      companyId, title: "Secret open descendant", status: "todo", privacyParentIssueId: privateRoot!.id, createdByUserId: "someone-else",
    }).returning();
    // A blocker edge from a hidden task must not surface it as a waiting-on chip.
    await db.insert(issueRelations).values({
      companyId, issueId: projectTask!.id, relatedIssueId: publicTask!.id, type: "blocks",
    });

    const svc = stapleConsoleService(db, { credentialProvider: async () => null });
    const asUser = (userId: string): AuthorizationActor => ({ type: "board", userId, authorizingUserId: userId });

    const hidden = await svc.board(companyId, asUser(outsider));
    expect(cards(hidden).map((card) => card.id)).toEqual([publicTask!.id]);
    expect(cards(hidden)[0]!.waitingOn).toEqual([]);
    expect(boardText(hidden)).not.toContain("Secret");

    await db.insert(projectAccessMembers).values({ companyId, projectId: project!.id, subjectType: "user", subjectId: reader });
    await db.insert(issueAccessGrants).values({ issueId: privateRoot!.id, subjectType: "user", subjectId: reader, source: "explicit" });
    const permitted = await svc.board(companyId, asUser(reader));
    expect(cards(permitted).map((card) => card.id).sort()).toEqual([publicTask!.id, projectTask!.id, descendant!.id].sort());
    expect(boardText(permitted)).toContain("Secret project task");
    expect(boardText(permitted)).toContain("Secret open descendant");
    expect(boardText(permitted)).not.toContain("Secret private root");
  });

  it("derives rounds from reviewer verdicts and native decisions, and Merged only from a merged PR (FAC-837/838)", async () => {
    const companyId = await seedCompany();
    const [coord, builder, reviewer] = await db.insert(agents).values([
      { companyId, name: "Workflow Coordinator", role: "general", adapterType: "codex_local" },
      { companyId, name: "Workflow Engineer", role: "engineer", adapterType: "claude_local" },
      { companyId, name: "Workflow Reviewer", role: "qa", adapterType: "codex_local" },
    ]).returning();
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60_000);
    const [root] = await db.insert(issues).values({
      companyId, title: "Console corrections", status: "blocked", assigneeAgentId: coord!.id, createdAt: hoursAgo(60),
    }).returning();
    const [impl] = await db.insert(issues).values({
      companyId, title: "Implement console corrections", status: "in_progress", parentId: root!.id, assigneeAgentId: builder!.id, createdAt: hoursAgo(60),
    }).returning();
    // Finished two days ago, so only the card scope (not "finished today") keeps its verdict.
    const [oldReview] = await db.insert(issues).values({
      companyId, title: "Review PR #31", status: "done", parentId: root!.id, assigneeAgentId: reviewer!.id, createdAt: hoursAgo(60),
      completedAt: hoursAgo(48),
    }).returning();
    const [review] = await db.insert(issues).values({
      companyId, title: "Review PR #32", status: "in_progress", parentId: root!.id, assigneeAgentId: reviewer!.id, createdAt: hoursAgo(60),
    }).returning();
    await db.insert(issueComments).values([
      { companyId, issueId: oldReview!.id, authorAgentId: reviewer!.id, body: "**PASS** at abc123.", createdAt: hoursAgo(49) },
      { companyId, issueId: review!.id, authorAgentId: reviewer!.id, body: "**REQUEST CHANGES** for PR 32 at def456.", createdAt: hoursAgo(3) },
      // The builder asking for re-review states no verdict, and a builder "PASS" on the review task never counts.
      { companyId, issueId: review!.id, authorAgentId: builder!.id, body: "PASS: fixed, verification please.", createdAt: hoursAgo(2) },
    ]);
    await db.insert(issueExecutionDecisions).values({
      companyId, issueId: impl!.id, stageId: randomUUID(), stageType: "review", actorAgentId: reviewer!.id,
      outcome: "changes_requested", body: "Native stage verdict", createdAt: hoursAgo(1),
    });

    const [doneTask] = await db.insert(issues).values({
      companyId, title: "Console nav link", status: "done", assigneeAgentId: coord!.id, completedAt: hoursAgo(0.5),
    }).returning();
    await db.insert(issueWorkProducts).values({
      companyId, issueId: doneTask!.id, type: "pull_request", provider: "github", title: "PR 33",
      url: "https://github.com/acme/widgets/pull/33", status: "active", metadata: { state: "open" },
    });

    const svc = stapleConsoleService(db, { credentialProvider: async () => null });
    const userId = randomUUID();
    const board = await svc.board(companyId, { type: "board", userId, authorizingUserId: userId });
    const card = cards(board).find((candidate) => candidate.id === root!.id)!;
    // Approval (old review), changes requested (open review), then a native changes-requested
    // verdict with no correction run between: one correction, back in Build round 2.
    expect(card.step).toBe("build");
    expect(card.round).toBe(2);
    const done = cards(board).find((candidate) => candidate.id === doneTask!.id)!;
    expect(done).toMatchObject({ step: "review", completion: "task_done", mergedToday: false });
    expect(done.completionNote).toBe("Task done; widgets#33 is still open, not merged");
    expect(board.header.mergedToday).toBe(0);
  });

  it("keeps Done work with an open PR past its completion day, and reads a native review stage (FAC-837/838)", async () => {
    const companyId = await seedCompany();
    const [builder, reviewer] = await db.insert(agents).values([
      { companyId, name: "Workflow Engineer", role: "engineer", adapterType: "claude_local" },
      { companyId, name: "Workflow Reviewer", role: "qa", adapterType: "codex_local" },
    ]).returning();
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60_000);
    const [openPrTask, mergedPrTask] = await db.insert(issues).values([
      { companyId, title: "Console nav link", status: "done", assigneeAgentId: builder!.id, completedAt: hoursAgo(48) },
      { companyId, title: "Console header", status: "done", assigneeAgentId: builder!.id, completedAt: hoursAgo(48) },
    ]).returning();
    await db.insert(issueWorkProducts).values([
      {
        companyId, issueId: openPrTask!.id, type: "pull_request", provider: "github", title: "PR 40",
        url: "https://github.com/acme/widgets/pull/40", status: "active", metadata: { state: "open" },
      },
      {
        companyId, issueId: mergedPrTask!.id, type: "pull_request", provider: "github", title: "PR 41",
        url: "https://github.com/acme/widgets/pull/41", status: "merged", metadata: { state: "merged" },
      },
    ]);
    const stageId = randomUUID();
    const [nativeTask] = await db.insert(issues).values({
      companyId, title: "Console rounds", status: "in_review", assigneeAgentId: reviewer!.id,
      executionPolicy: { mode: "normal", commentRequired: false, stages: [
        { id: stageId, type: "review", approvalsNeeded: 1, participants: [{ id: randomUUID(), type: "agent", agentId: reviewer!.id }] },
      ] },
      executionState: {
        status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewer!.id }, returnAssignee: { type: "agent", agentId: builder!.id },
        reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
      },
    }).returning();

    const svc = stapleConsoleService(db, { credentialProvider: async () => null });
    const userId = randomUUID();
    const board = await svc.board(companyId, { type: "board", userId, authorizingUserId: userId });
    const ids = cards(board).map((card) => card.id);
    expect(ids).toContain(openPrTask!.id);
    expect(ids).not.toContain(mergedPrTask!.id);
    expect(cards(board).find((card) => card.id === openPrTask!.id)).toMatchObject({
      step: "review", completion: "task_done", completionNote: "Task done; widgets#40 is still open, not merged",
    });
    expect(cards(board).find((card) => card.id === nativeTask!.id)).toMatchObject({ step: "review", round: 1 });
    expect(board.header.inFlight).toBe(2);
  });

  it("keeps PR links with unknown state when GitHub fails or the refresh is capped, dropping only 404 guesses", async () => {
    const companyId = await seedCompany();
    const url = (number: number) => `https://github.com/acme/widgets/pull/${number}`;
    // One PR per task so every link fits in its card's three-PR list.
    const tasks = await db.insert(issues).values(Array.from({ length: 26 }, (_, index) => ({
      companyId, title: `Widget task ${index + 1}`, status: "in_progress", description: url(index + 1),
    }))).returning();
    const [guessTask] = await db.insert(issues).values({ companyId, title: "PR #900 console wiring", status: "in_progress" }).returning();
    const requested: string[] = [];
    const fetch = async (target: string) => {
      requested.push(target);
      if (target.endsWith("/pulls/900")) return new Response("{}", { status: 404 });
      if (target.endsWith("/pulls/26")) return new Response("{}", { status: 503 });
      if (target.includes("/check-runs")) return Response.json({ check_runs: [] });
      if (target.endsWith("/commits/abc")) {
        return Response.json({ commit: { committer: { date: new Date(Date.now() - 20 * 60_000).toISOString() } } });
      }
      return Response.json({ state: "open", draft: false, merged_at: null, head: { sha: "abc" } });
    };
    const svc = stapleConsoleService(db, {
      fetch,
      credentialProvider: async () => ({ token: "test-token", source: "server_env", secretName: null }),
    });
    const userId = randomUUID();
    const board = await svc.board(companyId, { type: "board", userId, authorizingUserId: userId });
    const prsOf = (id: string) => cards(board).find((card) => card.id === id)!.pullRequests;
    const taskNumbered = (number: number) => tasks.find((task) => task.title === `Widget task ${number}`)!;

    // #900 is a bare-number guess GitHub definitively rejected.
    expect(prsOf(guessTask!.id)).toEqual([]);
    // #26 hit a GitHub outage: link kept, state unknown.
    expect(prsOf(taskNumbered(26).id)).toEqual([
      { label: "widgets#26", url: url(26), state: "unknown", ci: "unknown", source: "reference" },
    ]);
    // #1 and #2 are past the 25-PR refresh cap (900 and 26..3): never requested, links kept.
    for (const number of [1, 2]) {
      expect(requested.some((target) => target.endsWith(`/pulls/${number}`))).toBe(false);
      expect(prsOf(taskNumbered(number).id)).toEqual([
        { label: `widgets#${number}`, url: url(number), state: "unknown", ci: "unknown", source: "reference" },
      ]);
    }
    expect(prsOf(taskNumbered(3).id)).toEqual([
      { label: "widgets#3", url: url(3), state: "open", ci: "none", source: "github" },
    ]);
    // Zero check runs 20 min after the head commit: CI never started (FAC-840).
    expect(cards(board).find((card) => card.id === taskNumbered(3).id)!.stuck).toEqual([
      expect.objectContaining({ rule: "ci_not_started", reason: expect.stringContaining("PR #3 head abc has no CI check run") }),
    ]);
    expect(board.sources.github.detail).toContain("GitHub read failed for 1 of 25 PRs");
    expect(board.sources.github.detail).toContain("2 older PRs are beyond the 25-PR refresh limit");
  });
});
