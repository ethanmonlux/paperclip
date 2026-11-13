import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, authUsers, companies, createDb, issueComments, issueTreeHolds, issues, type Db } from "@paperclipai/db";
import { DEFAULT_PAUSE_HOLD_TTL_MS, PAUSE_HOLD_EXPIRED_RELEASE_REASON, issueTreeControlService } from "../services/issue-tree-control.js";
import { expireDuePauseHolds, expiredHoldMemberWakeKey } from "../services/issue-tree-hold-expiry.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_ISSUE_TREE_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();

// STA-361 (FAC-840): a pause hold names an owner and an expiry, so it cannot
// park a tree forever. STA-219 and STA-310 sat paused with nothing to end it.
(support.supported ? describe : describe.skip)("pause hold expiry", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("tree-hold-expiry-");
    db = createDb(external ?? temporary!.connectionString);
    db.$client.options.onnotice = () => {};
  }, 30_000);
  afterEach(async () => {
    vi.useRealTimers();
    await db.execute(sql`truncate companies, "user" cascade`);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  const boardUserId = "board-ethan";
  const boardActor = { actorType: "user" as const, actorId: boardUserId, userId: boardUserId };

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Expiry", issuePrefix: `E${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Workflow Engineer", role: "engineer", status: "idle" });
    await db.insert(authUsers).values({ id: boardUserId, name: "Ethan", email: "ethan@example.com", emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    const [root] = await db.insert(issues).values({ companyId, title: "Root", status: "todo", assigneeAgentId: agentId }).returning();
    const [running] = await db.insert(issues).values({ companyId, parentId: root.id, title: "Running child",
      status: "in_progress", assigneeAgentId: agentId }).returning();
    const [blocked] = await db.insert(issues).values({ companyId, parentId: root.id, title: "Blocked child",
      status: "blocked", assigneeAgentId: agentId }).returning();
    return { companyId, agentId, root, running, blocked };
  }

  const wakeQueue = () => vi.fn(async (_agentId: string, _input: Record<string, any>) => ({ id: randomUUID() }));
  const holdRow = (holdId: string) => db.select().from(issueTreeHolds).where(eq(issueTreeHolds.id, holdId)).then(rows => rows[0]);

  it("gives a new pause hold its creator as owner and a 12 hour expiry unless set", async () => {
    const f = await fixture();
    const svc = issueTreeControlService(db);
    const before = Date.now();
    const { hold } = await svc.createHold(f.companyId, f.root.id, { mode: "pause", actor: boardActor });
    expect(hold).toMatchObject({ ownerUserId: boardUserId, ownerAgentId: null });
    expect(hold.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + DEFAULT_PAUSE_HOLD_TTL_MS);
    expect(hold.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + DEFAULT_PAUSE_HOLD_TTL_MS);

    const expiresAt = new Date(Date.now() + 30 * 60_000);
    const { hold: owned } = await svc.createHold(f.companyId, f.running.id, { mode: "pause", actor: boardActor,
      ownerAgentId: f.agentId, expiresAt: expiresAt.toISOString() });
    expect(owned).toMatchObject({ ownerAgentId: f.agentId, ownerUserId: null, expiresAt });

    await expect(svc.createHold(f.companyId, f.blocked.id, { mode: "pause", actor: boardActor,
      expiresAt: new Date(Date.now() - 1_000).toISOString() })).rejects.toThrow(/must be in the future/);
    await expect(svc.createHold(f.companyId, f.blocked.id, { mode: "pause",
      actor: { actorType: "system", actorId: "system" } })).rejects.toThrow(/needs an owner/);
    await expect(svc.createHold(f.companyId, f.blocked.id, { mode: "pause", actor: boardActor,
      ownerAgentId: randomUUID() })).rejects.toThrow(/owner agent not found/);
  });

  it("releases an expired hold, wakes its runnable members once, and posts one comment naming the owner", async () => {
    const f = await fixture();
    const svc = issueTreeControlService(db);
    const expiresAt = new Date(Date.now() + 60_000);
    const { hold } = await svc.createHold(f.companyId, f.root.id, { mode: "pause", reason: "Install window",
      actor: boardActor, expiresAt: expiresAt.toISOString() });
    const wakeup = wakeQueue();

    const now = new Date(expiresAt.getTime() + 1_000);
    const result = await expireDuePauseHolds(db, { companyId: f.companyId, wakeup, now });
    expect(result.expiredHoldIds).toEqual([hold.id]);
    expect(result.nextExpiresAt).toBeNull();

    const released = await holdRow(hold.id);
    expect(released).toMatchObject({ status: "released", releaseReason: PAUSE_HOLD_EXPIRED_RELEASE_REASON,
      releasedByActorType: "system" });
    expect(released.releaseMetadata).toMatchObject({ expired: true, expiresAt: expiresAt.toISOString() });
    expect(await svc.getActivePauseHoldGate(f.companyId, f.running.id)).toBeNull();

    // The executable members wake; the blocked child is unpaused but stays idle.
    const woken = wakeup.mock.calls.map(([agentId, input]) => ({ agentId, issueId: input.payload.issueId,
      reason: input.reason, key: input.idempotencyKey }));
    expect(woken).toEqual(expect.arrayContaining([
      { agentId: f.agentId, issueId: f.root.id, reason: "issue_tree_resumed", key: expiredHoldMemberWakeKey(hold.id, f.root.id) },
      { agentId: f.agentId, issueId: f.running.id, reason: "issue_tree_resumed", key: expiredHoldMemberWakeKey(hold.id, f.running.id) },
    ]));
    expect(woken).toHaveLength(2);
    expect(result.wokenIssueIds.sort()).toEqual([f.root.id, f.running.id].sort());

    const audit = await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId),
      eq(activityLog.action, "issue.tree_hold_expired")));
    expect(audit).toEqual([expect.objectContaining({ entityId: f.root.id, actorType: "system",
      details: expect.objectContaining({ holdId: hold.id, ownerUserId: boardUserId }) })]);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.root.id));
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("Owner: Ethan");
    expect(comments[0].body).toContain("Pause reason: Install window");

    // A second sweep finds nothing to release: no second wake or comment.
    const again = await expireDuePauseHolds(db, { companyId: f.companyId, wakeup, now: new Date(now.getTime() + 60_000) });
    expect(again.expiredHoldIds).toEqual([]);
    expect(wakeup).toHaveBeenCalledTimes(2);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.root.id))).toHaveLength(1);
  });

  it("leaves a hold with time left in place and names its expiry as the next check", async () => {
    const f = await fixture();
    const svc = issueTreeControlService(db);
    const expiresAt = new Date(Date.now() + 2 * 60 * 60_000);
    const { hold } = await svc.createHold(f.companyId, f.root.id, { mode: "pause", actor: boardActor,
      expiresAt: expiresAt.toISOString() });
    const wakeup = wakeQueue();

    const result = await expireDuePauseHolds(db, { companyId: f.companyId, wakeup, now: new Date(expiresAt.getTime() - 1_000) });
    expect(result.expiredHoldIds).toEqual([]);
    expect(result.nextExpiresAt).toBe(expiresAt.getTime());
    expect(await holdRow(hold.id)).toMatchObject({ status: "active", releasedAt: null });
    expect(await svc.getActivePauseHoldGate(f.companyId, f.running.id)).toMatchObject({ holdId: hold.id });
    expect(wakeup).not.toHaveBeenCalled();
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.root.id))).toHaveLength(0);
  });

  it("does not release a hold an operator already released", async () => {
    const f = await fixture();
    const svc = issueTreeControlService(db);
    const expiresAt = new Date(Date.now() + 60_000);
    const { hold } = await svc.createHold(f.companyId, f.root.id, { mode: "pause", actor: boardActor,
      expiresAt: expiresAt.toISOString() });
    await svc.releaseHold(f.companyId, f.root.id, hold.id, { reason: "Operator resumed", actor: boardActor });
    const wakeup = wakeQueue();

    const result = await expireDuePauseHolds(db, { companyId: f.companyId, wakeup, now: new Date(expiresAt.getTime() + 1_000) });
    expect(result.expiredHoldIds).toEqual([]);
    expect(await holdRow(hold.id)).toMatchObject({ status: "released", releaseReason: "Operator resumed" });
    expect(wakeup).not.toHaveBeenCalled();
  });
});
