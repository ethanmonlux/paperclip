import { randomUUID } from "node:crypto";
import { and, asc, eq, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents, chatConversations, chatDeliveries, chatEndpoints, chatExternalPrincipals, chatIdentityLinks,
  chatPublications, companies, companyMemberships, createDb, heartbeatRuns, issueThreadInteractions, issues,
  toolApplications, toolConnections,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  FOUNDER_FALLBACK_KEY_PREFIX, createFounderFallbackNotices, founderFallbackKey, founderFallbackSettingsFromEnv,
  isFounderFallbackPublication, parseFounderFallbackKey,
} from "../services/founder-fallback-notices.js";

const MINUTE = 60_000;
const BOUND = 20 * MINUTE;

describe("founder fallback keys and settings", () => {
  it("round-trips every key kind and rejects anything else", () => {
    const endpointId = randomUUID(), agentId = randomUUID(), interactionId = randomUUID(), runId = randomUUID();
    for (const key of [
      { endpointId, kind: "agent", agentId, anchor: `error.${runId}` },
      { endpointId, kind: "agent", agentId, anchor: "error.none" },
      { endpointId, kind: "agent", agentId, anchor: "paused.1793732233969" },
      { endpointId, kind: "recovered", agentId, anchor: "terminated" },
      { endpointId, kind: "item", interactionId },
    ] as const) {
      const value = founderFallbackKey(key);
      expect(value.startsWith(FOUNDER_FALLBACK_KEY_PREFIX)).toBe(true);
      expect(isFounderFallbackPublication({ idempotencyKey: value })).toBe(true);
      expect(parseFounderFallbackKey(value)).toEqual(key);
    }
    for (const value of [
      `${FOUNDER_FALLBACK_KEY_PREFIX}${endpointId}:agent:${agentId}:error.x`,
      `${FOUNDER_FALLBACK_KEY_PREFIX}${endpointId}:item:${interactionId}:extra`,
      `${FOUNDER_FALLBACK_KEY_PREFIX}${endpointId.toUpperCase()}:item:${interactionId}`,
      `founder-fallback:v2:${endpointId}:item:${interactionId}`,
      `fast-response:${interactionId}`,
    ]) expect(parseFounderFallbackKey(value)).toBeNull();
    expect(isFounderFallbackPublication({ idempotencyKey: `fast-response:${interactionId}` })).toBe(false);
  });

  it("is off unless explicitly enabled and clamps the bound", () => {
    expect(founderFallbackSettingsFromEnv({})).toEqual({ enabled: false, boundMs: BOUND });
    expect(founderFallbackSettingsFromEnv({ PAPERCLIP_FOUNDER_FALLBACK_NOTICES: "1" }).enabled).toBe(false);
    expect(founderFallbackSettingsFromEnv({ PAPERCLIP_FOUNDER_FALLBACK_NOTICES: "true" }).enabled).toBe(true);
    expect(founderFallbackSettingsFromEnv({ PAPERCLIP_FOUNDER_FALLBACK_BOUND_MINUTES: "1" }).boundMs).toBe(5 * MINUTE);
    expect(founderFallbackSettingsFromEnv({ PAPERCLIP_FOUNDER_FALLBACK_BOUND_MINUTES: "9999" }).boundMs).toBe(360 * MINUTE);
    expect(founderFallbackSettingsFromEnv({ PAPERCLIP_FOUNDER_FALLBACK_BOUND_MINUTES: "7.5" }).boundMs).toBe(BOUND);
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("founder fallback notices", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("founder-fallback-notices-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterEach(async () => {
    for (const table of [chatPublications, chatDeliveries, chatIdentityLinks, chatExternalPrincipals, chatConversations,
      chatEndpoints, toolConnections, toolApplications, issueThreadInteractions, heartbeatRuns, issues, companyMemberships,
      agents, companies]) await db.delete(table);
  });
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  const start = new Date("2026-11-03T12:00:00.000Z");
  let now = start;
  const at = (minutes: number) => { now = new Date(start.getTime() + minutes * MINUTE); };

  async function fixture() {
    now = start;
    const companyId = randomUUID(), agentId = randomUUID(), workerId = randomUUID(), dmIssueId = randomUUID();
    const otherIssueId = randomUUID(), applicationId = randomUUID(), connectionId = randomUUID();
    const endpointId = randomUUID(), conversationId = randomUUID(), principalId = randomUUID();
    const founderUserId = `founder-${randomUUID()}`;
    await db.insert(companies).values({ id: companyId, name: "Fallback", issuePrefix: `F${companyId.slice(0, 4).toUpperCase()}` });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: founderUserId, status: "active", membershipRole: "owner" });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Master Builder", status: "idle", updatedAt: start },
      { id: workerId, companyId, name: "Workflow Coordinator", status: "idle" },
    ]);
    await db.insert(issues).values([
      { id: dmIssueId, companyId, title: "Founder DM", assigneeAgentId: agentId, identifier: "F-1" },
      { id: otherIssueId, companyId, title: "Protected decision task", identifier: "F-2" },
    ]);
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Discord", type: "chat" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Discord", uid: connectionId, transport: "chat_sdk", connectionPurpose: "channel" });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, provider: "discord", publicId: endpointId,
      assignedAgentId: agentId, status: "active", allowDirectMessages: true });
    await db.insert(chatConversations).values({ id: conversationId, companyId, endpointId, issueId: dmIssueId,
      externalConversationId: "dm-1", externalLabel: "Founder DM", isDirectMessage: true, state: "waiting" });
    await addSender({ companyId, endpointId, conversationId, principalId, userId: founderUserId });
    const service = createFounderFallbackNotices(db, { enabled: true, boundMs: BOUND }, () => now);
    return { companyId, agentId, workerId, dmIssueId, otherIssueId, endpointId, conversationId, founderUserId, service };
  }

  async function addSender(input: { companyId: string; endpointId: string; conversationId: string; principalId: string; userId: string }) {
    await db.insert(chatExternalPrincipals).values({ id: input.principalId, companyId: input.companyId, provider: "discord",
      providerAccountId: "bot", externalId: input.principalId });
    await db.insert(chatIdentityLinks).values({ companyId: input.companyId, endpointId: input.endpointId, principalId: input.principalId,
      paperclipUserId: input.userId, status: "linked", confirmedAt: start });
    await db.insert(chatDeliveries).values({ companyId: input.companyId, endpointId: input.endpointId, conversationId: input.conversationId,
      principalId: input.principalId, providerEventId: randomUUID(), deduplicationKey: randomUUID(), eventKind: "direct_message",
      normalizedEvent: {}, state: "processed" });
  }

  async function failAgent(f: Awaited<ReturnType<typeof fixture>>, finishedAt: Date) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "failed",
      createdAt: finishedAt, startedAt: finishedAt, finishedAt }).returning();
    await db.update(agents).set({ status: "error", updatedAt: finishedAt }).where(eq(agents.id, f.agentId));
    return run!;
  }

  async function interaction(f: Awaited<ReturnType<typeof fixture>>, values: Partial<typeof issueThreadInteractions.$inferInsert>) {
    const [row] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.otherIssueId,
      kind: "request_confirmation", payload: { version: 1, prompt: "Approve?" } as never, title: "Approve the canary",
      createdByAgentId: f.workerId, createdAt: start, ...values }).returning();
    return row!;
  }

  const rows = (f: { companyId: string }) => db.select().from(chatPublications)
    .where(and(eq(chatPublications.companyId, f.companyId), like(chatPublications.idempotencyKey, `${FOUNDER_FALLBACK_KEY_PREFIX}%`)))
    .orderBy(asc(chatPublications.createdAt), asc(chatPublications.idempotencyKey));
  const text = (row: typeof chatPublications.$inferSelect) => String((row.payload as { text?: unknown }).text ?? "");

  it("stays quiet while the endpoint agent is available or only briefly unavailable", async () => {
    const f = await fixture();
    await interaction(f, { addresseeAgentId: f.agentId });
    at(5);
    expect(await f.service.sweep()).toEqual({ targets: 1, inserted: 0 });
    await failAgent(f, now);
    at(5 + 19);
    expect((await f.service.sweep()).inserted).toBe(0);
    expect(await rows(f)).toEqual([]);
  });

  it("sends one labelled agent notice and one notice per waiting item into the same founder DM, deduplicated", async () => {
    const f = await fixture();
    const escalation = await interaction(f, { addresseeAgentId: f.agentId, title: "Coordinator needs Master Builder" });
    const decision = await interaction(f, { addresseeUserId: f.founderUserId, title: "Founder approval" });
    await interaction(f, { addresseeUserId: f.founderUserId, issueId: f.dmIssueId, title: "Native DM card" });
    await interaction(f, { addresseeAgentId: f.workerId, title: "Not for the founder" });
    const run = await failAgent(f, start);
    at(21);
    expect(await f.service.sweep()).toEqual({ targets: 1, inserted: 3 });
    const published = await rows(f);
    expect(published.map(row => row.idempotencyKey).sort()).toEqual([
      founderFallbackKey({ endpointId: f.endpointId, kind: "agent", agentId: f.agentId, anchor: `error.${run.id}` }),
      founderFallbackKey({ endpointId: f.endpointId, kind: "item", interactionId: escalation.id }),
      founderFallbackKey({ endpointId: f.endpointId, kind: "item", interactionId: decision.id }),
    ].sort());
    for (const row of published) {
      expect(row).toMatchObject({ conversationId: f.conversationId, issueId: f.dmIssueId, endpointId: f.endpointId, state: "pending" });
      expect(text(row).startsWith("Paperclip fallback notice (automatic, not from Master Builder).")).toBe(true);
    }
    const agentNotice = published.find(row => row.idempotencyKey.includes(":agent:"))!;
    expect(text(agentNotice)).toContain(`Master Builder has been in error since 2026-11-03 12:00 UTC (run ${run.id.slice(0, 8)} failed).`);
    expect(text(agentNotice)).toContain("Waiting on Master Builder: 1 escalation(s). Waiting on you: 1 decision(s).");
    const decisionNotice = published.find(row => row.idempotencyKey.endsWith(decision.id))!;
    expect(text(decisionNotice)).toContain("F-2 · Protected decision task");
    expect(text(decisionNotice)).toContain('Decision waiting for you from Workflow Coordinator, raised 2026-11-03 12:00 UTC: "Founder approval"');
    expect(text(decisionNotice)).toContain("a reply in this chat does not resolve it");
    expect(text(published.find(row => row.idempotencyKey.endsWith(escalation.id))!)).toContain("Escalation to Master Builder");

    at(40);
    expect((await f.service.sweep()).inserted).toBe(0);
    expect(await rows(f)).toHaveLength(3);
  });

  it("re-proves each notice at the transport claim and fails closed when its condition is gone", async () => {
    const f = await fixture();
    const decision = await interaction(f, { addresseeUserId: f.founderUserId });
    await failAgent(f, start);
    at(21);
    await f.service.sweep();
    const [agentNotice, itemNotice] = await (async () => {
      const all = await rows(f);
      return [all.find(row => row.idempotencyKey.includes(":agent:"))!, all.find(row => row.idempotencyKey.endsWith(decision.id))!];
    })();
    expect(await f.service.authorizeFounderFallbackPublication(db, agentNotice)).toBe(true);
    expect(await f.service.authorizeFounderFallbackPublication(db, itemNotice)).toBe(true);

    // A disabled service never authorizes, even for an existing row.
    const disabled = createFounderFallbackNotices(db, { enabled: false, boundMs: BOUND }, () => now);
    expect(await disabled.authorizeFounderFallbackPublication(db, agentNotice)).toBe(false);
    expect(await disabled.sweep()).toEqual({ targets: 0, inserted: 0 });
    // A key moved to another conversation, issue or endpoint does not authorize.
    expect(await f.service.authorizeFounderFallbackPublication(db, { ...agentNotice, conversationId: randomUUID() })).toBe(false);
    expect(await f.service.authorizeFounderFallbackPublication(db, { ...agentNotice, issueId: f.otherIssueId })).toBe(false);
    expect(await f.service.authorizeFounderFallbackPublication(db, { ...agentNotice, endpointId: randomUUID() })).toBe(false);

    await db.update(issueThreadInteractions).set({ status: "accepted" }).where(eq(issueThreadInteractions.id, decision.id));
    expect(await f.service.authorizeFounderFallbackPublication(db, itemNotice)).toBe(false);

    await db.update(chatEndpoints).set({ status: "paused" }).where(eq(chatEndpoints.id, f.endpointId));
    expect(await f.service.authorizeFounderFallbackPublication(db, agentNotice)).toBe(false);
    await db.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, f.endpointId));

    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
    expect(await f.service.authorizeFounderFallbackPublication(db, agentNotice)).toBe(false);
  });

  it("fails closed unless every DM sender links to the same active company owner", async () => {
    const f = await fixture();
    await failAgent(f, start);
    at(21);
    await db.update(companyMemberships).set({ membershipRole: "member" }).where(eq(companyMemberships.companyId, f.companyId));
    expect(await f.service.sweep()).toEqual({ targets: 0, inserted: 0 });
    await db.update(companyMemberships).set({ membershipRole: "owner" }).where(eq(companyMemberships.companyId, f.companyId));

    await addSender({ companyId: f.companyId, endpointId: f.endpointId, conversationId: f.conversationId,
      principalId: randomUUID(), userId: `someone-${randomUUID()}` });
    expect(await f.service.sweep()).toEqual({ targets: 0, inserted: 0 });

    expect(await rows(f)).toEqual([]);

    // Once every sender links to the founder again the notice goes out, and a
    // later revocation fails its transport re-proof.
    await db.update(chatIdentityLinks).set({ paperclipUserId: f.founderUserId }).where(eq(chatIdentityLinks.companyId, f.companyId));
    expect(await f.service.sweep()).toEqual({ targets: 1, inserted: 1 });
    const [notice] = await rows(f);
    expect(await f.service.authorizeFounderFallbackPublication(db, notice!)).toBe(true);
    const [link] = await db.select().from(chatIdentityLinks).where(eq(chatIdentityLinks.companyId, f.companyId)).limit(1);
    await db.update(chatIdentityLinks).set({ revokedAt: now }).where(eq(chatIdentityLinks.id, link!.id));
    expect(await f.service.authorizeFounderFallbackPublication(db, notice!)).toBe(false);
  });

  it("closes a delivered episode with one recovery notice and opens a new episode for a new failure", async () => {
    const f = await fixture();
    const first = await failAgent(f, start);
    at(21);
    await f.service.sweep();
    const firstKey = founderFallbackKey({ endpointId: f.endpointId, kind: "agent", agentId: f.agentId, anchor: `error.${first.id}` });

    // An episode that was never delivered gets no recovery notice.
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
    at(25);
    expect((await f.service.sweep()).inserted).toBe(0);

    await db.update(chatPublications).set({ state: "delivery_unknown" }).where(eq(chatPublications.idempotencyKey, firstKey));
    at(26);
    expect((await f.service.sweep()).inserted).toBe(1);
    at(27);
    expect((await f.service.sweep()).inserted).toBe(0);
    const recovered = (await rows(f)).find(row => row.idempotencyKey.includes(":recovered:"))!;
    expect(recovered.idempotencyKey).toBe(founderFallbackKey({ endpointId: f.endpointId, kind: "recovered", agentId: f.agentId, anchor: `error.${first.id}` }));
    expect(text(recovered)).toContain("Master Builder is available again (status idle)");
    expect(await f.service.authorizeFounderFallbackPublication(db, recovered)).toBe(true);

    at(30);
    const second = await failAgent(f, now);
    at(51);
    expect((await f.service.sweep()).inserted).toBe(1);
    expect((await rows(f)).map(row => row.idempotencyKey)).toContain(
      founderFallbackKey({ endpointId: f.endpointId, kind: "agent", agentId: f.agentId, anchor: `error.${second.id}` }));
    // The recovery notice of the old episode no longer authorizes while the agent is down again.
    expect(await f.service.authorizeFounderFallbackPublication(db, recovered)).toBe(false);
  });

  it("keeps one episode while failed retries move the anchor, until recovery is observed", async () => {
    const f = await fixture();
    const first = await failAgent(f, start);
    at(21);
    expect((await f.service.sweep()).inserted).toBe(1);
    const firstKey = founderFallbackKey({ endpointId: f.endpointId, kind: "agent", agentId: f.agentId, anchor: `error.${first.id}` });
    await db.update(chatPublications).set({ state: "published" }).where(eq(chatPublications.idempotencyKey, firstKey));

    // Retries keep failing more than one bound apart: still the same outage.
    for (const minute of [30, 60, 90]) {
      at(minute);
      await failAgent(f, now);
      at(minute + 25);
      expect((await f.service.sweep()).inserted).toBe(0);
    }
    expect((await rows(f)).map(row => row.idempotencyKey)).toEqual([firstKey]);

    // A notice that never reached the founder does not hold the episode.
    await db.update(chatPublications).set({ state: "cancelled" }).where(eq(chatPublications.idempotencyKey, firstKey));
    expect((await f.service.sweep()).inserted).toBe(1);
    expect(await rows(f)).toHaveLength(2);
  });

  it("anchors paused and terminated agents durably across restarts", async () => {
    const f = await fixture();
    const pausedAt = new Date(start.getTime() + MINUTE);
    await db.update(agents).set({ status: "paused", pausedAt }).where(eq(agents.id, f.agentId));
    at(22);
    expect((await f.service.sweep()).inserted).toBe(1);
    const restarted = createFounderFallbackNotices(db, { enabled: true, boundMs: BOUND }, () => now);
    at(30);
    expect((await restarted.sweep()).inserted).toBe(0);
    expect((await rows(f)).map(row => row.idempotencyKey)).toEqual([
      founderFallbackKey({ endpointId: f.endpointId, kind: "agent", agentId: f.agentId, anchor: `paused.${pausedAt.getTime()}` }),
    ]);
    await db.update(agents).set({ status: "terminated", updatedAt: now }).where(eq(agents.id, f.agentId));
    at(51);
    expect((await restarted.sweep()).inserted).toBe(1);
    expect(text((await rows(f)).at(-1)!)).toContain("Master Builder has been terminated.");
  });

  it("flags an escalation the available agent never picked up, and stays quiet once it starts work", async () => {
    const f = await fixture();
    const pickedUp = await interaction(f, { addresseeAgentId: f.agentId, title: "Picked-up escalation" });
    const unread = await interaction(f, { addresseeAgentId: f.agentId, title: "Unread escalation", createdAt: new Date(start.getTime() + MINUTE) });
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "succeeded",
      createdAt: new Date(start.getTime() + 2 * MINUTE), startedAt: new Date(start.getTime() + 2 * MINUTE) });
    // A run started after both escalations, so neither was missed.
    at(30);
    expect((await f.service.sweep()).inserted).toBe(0);

    // With the only run between them, just the later escalation was missed.
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "succeeded",
      createdAt: new Date(start.getTime() + MINUTE / 2), startedAt: new Date(start.getTime() + MINUTE / 2) });
    expect((await f.service.sweep()).inserted).toBe(1);
    const [notice] = await rows(f);
    expect(notice!.idempotencyKey).toBe(founderFallbackKey({ endpointId: f.endpointId, kind: "item", interactionId: unread.id }));
    expect(notice!.idempotencyKey).not.toContain(pickedUp.id);
    expect(text(notice!)).toContain("Master Builder has not started any work since this escalation reached it 29 min ago.");

    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running", createdAt: now, startedAt: now });
    expect(await f.service.authorizeFounderFallbackPublication(db, notice!)).toBe(false);
  });

  it("bounds item notices per sweep and finishes the rest on the next sweep", async () => {
    const f = await fixture();
    await failAgent(f, start);
    const created = [];
    for (let index = 0; index < 7; index += 1) {
      created.push(await interaction(f, { addresseeUserId: f.founderUserId, title: `Decision ${index}`,
        createdAt: new Date(start.getTime() + index * 1000) }));
    }
    at(21);
    expect((await f.service.sweep()).inserted).toBe(1 + 5);
    expect((await f.service.sweep()).inserted).toBe(2);
    expect((await rows(f)).filter(row => row.idempotencyKey.includes(":item:"))).toHaveLength(7);
    expect(created).toHaveLength(7);
  });
});
