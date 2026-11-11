import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb, issues, issueWorkProducts, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import type { StapleConsoleBoard } from "@paperclipai/shared/staple-console";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const credentials = vi.hoisted(() => ({
  resolveGitHubApiCredential: vi.fn(),
  resolveManagedGitHubCredential: vi.fn(),
}));
vi.mock("../services/git-credentials.js", () => credentials);

const { stapleConsoleService } = await import("../services/staple-console.js");

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

const cards = (board: StapleConsoleBoard) => board.lanes.flatMap((lane) => lane.cards);

// STA-205: the console reads PR/CI through the managed GitHub connection already on the box.
suite("staple console GitHub source", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("staple-console-github-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  beforeEach(() => {
    credentials.resolveGitHubApiCredential.mockReset().mockResolvedValue(null);
    credentials.resolveManagedGitHubCredential.mockReset();
  });

  it("reads live PR state with the viewer's own managed grant and labels everyone else's view as recorded", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Staple", issuePrefix: `G${companyId.slice(0, 6).toUpperCase()}` });
    const [task] = await db.insert(issues).values({ companyId, title: "Console PR task", status: "in_review" }).returning();
    const url = "https://github.com/acme/paperclip/pull/26";
    // Paperclip's record went stale: it still says open after the PR merged.
    await db.insert(issueWorkProducts).values({
      companyId, issueId: task!.id, type: "pull_request", provider: "github", title: "PR 26", url, status: "active",
    });
    const founder = randomUUID();
    const viewer = randomUUID();
    credentials.resolveManagedGitHubCredential.mockImplementation(async (_db, _secrets, _companyId, context) =>
      context.responsibleUserId === founder
        ? { configured: true, credential: { token: "founder-grant", source: "managed_connection", secretName: null, githubIdentity: { userId: "1", login: "founder-gh" } } }
        : { configured: true, error: "No managed GitHub identity is available for this run" });
    const requests: Array<{ url: string; token: string | null }> = [];
    const fetch = async (target: string, init?: RequestInit) => {
      requests.push({ url: target, token: new Headers(init?.headers).get("authorization") });
      return Response.json({ state: "closed", draft: false, merged_at: "2026-11-09T13:24:00Z", head: { sha: "abc" } });
    };
    const svc = stapleConsoleService(db, { fetch });
    const asUser = (userId: string) => ({ type: "board" as const, userId, authorizingUserId: userId });

    const live = await svc.board(companyId, asUser(founder));
    expect(credentials.resolveManagedGitHubCredential).toHaveBeenCalledWith(db, expect.anything(), companyId, {
      responsibleUserId: founder, agentId: null, allowStandingDelegation: false,
    });
    // The PR, then its merged head's checks (Level 4 CI proof).
    expect(requests).toEqual([
      { url: "https://api.github.com/repos/acme/paperclip/pulls/26", token: "Bearer founder-grant" },
      { url: "https://api.github.com/repos/acme/paperclip/commits/abc/check-runs?per_page=100", token: "Bearer founder-grant" },
    ]);
    expect(cards(live)[0]!.pullRequests).toEqual([
      {
        label: "paperclip#26", url, state: "merged", ci: "unknown", source: "github",
        mergedAt: "2026-11-09T13:24:00Z", mergeCommitSha: null, inInstalledBuild: null,
      },
    ]);
    expect(live.sources.github).toEqual({
      available: true, detail: expect.stringContaining("your connected GitHub account (founder-gh)"),
    });

    // A second refresh revalidates the grant but reuses the PR read checked with this same token.
    await svc.board(companyId, asUser(founder));
    expect(credentials.resolveManagedGitHubCredential).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(2);

    // Another viewer with no grant of their own never gets the founder's grant or cached read.
    const recorded = await svc.board(companyId, asUser(viewer));
    expect(requests).toHaveLength(2);
    expect(cards(recorded)[0]!.pullRequests).toEqual([
      { label: "paperclip#26", url, state: "open", ci: "unknown", source: "work_product", mergedAt: null, mergeCommitSha: null, inInstalledBuild: null },
    ]);
    expect(recorded.sources.github).toEqual({ available: false, detail: expect.stringContaining("recorded status (not live)") });

    // A different grant for the same GitHub login (reconnect, rotation or narrower access) is checked by GitHub again.
    const grant = (token: string) => ({
      configured: true, credential: { token, source: "managed_connection", secretName: null, githubIdentity: { userId: "1", login: "founder-gh" } },
    });
    credentials.resolveManagedGitHubCredential.mockResolvedValue(grant("founder-rotated"));
    await svc.board(companyId, asUser(founder));
    expect(requests.at(-2)).toEqual({ url: "https://api.github.com/repos/acme/paperclip/pulls/26", token: "Bearer founder-rotated" });
    expect(requests).toHaveLength(4);

    // The same token in another company does not reuse this company's read.
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Other", issuePrefix: `H${otherCompanyId.slice(0, 6).toUpperCase()}` });
    const [otherTask] = await db.insert(issues).values({ companyId: otherCompanyId, title: "Other PR task", status: "in_review" }).returning();
    await db.insert(issueWorkProducts).values({
      companyId: otherCompanyId, issueId: otherTask!.id, type: "pull_request", provider: "github", title: "PR 26", url, status: "active",
    });
    await svc.board(otherCompanyId, asUser(founder));
    expect(requests).toHaveLength(6);

    // Revoking the grant stops live reads on the next refresh, even though the PR read is still cached.
    credentials.resolveManagedGitHubCredential.mockResolvedValue({ configured: true, error: "Grant revoked" });
    const revoked = await svc.board(companyId, asUser(founder));
    expect(requests).toHaveLength(6);
    expect(cards(revoked)[0]!.pullRequests).toEqual([
      { label: "paperclip#26", url, state: "open", ci: "unknown", source: "work_product", mergedAt: null, mergeCommitSha: null, inInstalledBuild: null },
    ]);

    // An agent caller has no personal grant, so the managed path is not consulted at all.
    credentials.resolveManagedGitHubCredential.mockClear();
    await svc.board(companyId, { type: "agent", agentId: randomUUID(), companyId });
    expect(credentials.resolveManagedGitHubCredential).not.toHaveBeenCalled();
  });

  it("keeps source, installed revision and last-good comparison distinct across a failed refresh", async () => {
    const installed = "a".repeat(40);
    const source = "b".repeat(40);
    let clock = new Date("2026-11-11T03:00:00Z");
    let fail = false;
    const fetch = async (target: string) => {
      if (fail) return new Response(null, { status: 503 });
      if (target.endsWith("/commits/master")) return Response.json({ sha: source });
      if (target.includes("/compare/")) return Response.json({ status: "ahead", files: [
        { filename: "server/src/services/native-runtime/example.ts" },
      ] });
      throw new Error(`Unexpected GitHub path: ${target}`);
    };
    const svc = stapleConsoleService(db, {
      now: () => clock, installedRevision: () => installed, fetch,
      credentialProvider: async () => ({ token: "atlas-grant", source: "managed_connection", secretName: null, login: "owner" }),
    });
    const actor = { type: "board" as const, userId: randomUUID(), authorizingUserId: randomUUID() };
    const first = await svc.atlasSource(randomUUID(), actor);
    expect(first).toMatchObject({ authoredRevision: installed, installedRevision: installed, sourceRevision: source,
      status: "changed", changedPaths: ["server/src/services/native-runtime/example.ts"], observedAt: clock.toISOString() });
    clock = new Date(clock.getTime() + 3 * 60_000);
    fail = true;
    const second = await svc.atlasSource(randomUUID(), actor);
    expect(second.status).toBe("unknown");
    expect(second.sourceRevision).toBeNull();
    // A failed read for the same authorized scope preserves last-good evidence without calling it current.
    const companyId = randomUUID();
    fail = false;
    clock = new Date("2026-11-11T04:00:00Z");
    await svc.atlasSource(companyId, actor);
    fail = true;
    clock = new Date(clock.getTime() + 3 * 60_000);
    const lastGood = await svc.atlasSource(companyId, actor);
    expect(lastGood).toMatchObject({ status: "unknown", sourceRevision: source, changedPaths: first.changedPaths,
      observedAt: "2026-11-11T04:00:00.000Z" });
  });
});
