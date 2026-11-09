import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  issueAccessGrants,
  issueRelations,
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
    expect(board.sources.github.detail).toContain("GitHub read failed for 1 of 25 PRs");
    expect(board.sources.github.detail).toContain("2 older PRs are beyond the 25-PR refresh limit");
  });
});
