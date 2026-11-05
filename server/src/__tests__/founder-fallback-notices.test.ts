import { randomUUID } from "node:crypto";
import { and, asc, eq, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, chatConversations, chatDeliveries, chatEndpoints, chatExternalPrincipals, chatIdentityLinks,
  chatPublications, companies, companyMemberships, createDb, heartbeatRuns, issueThreadInteractions, issues,
  toolApplications, toolConnections,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  FOUNDER_FALLBACK_KEY_PREFIX, MAX_FOUNDER_FALLBACK_REARMS, createFounderFallbackNotices, founderFallbackDefinitelyUnsent,
  founderFallbackKey, founderFallbackSettingsFromEnv, isFounderFallbackPublication, isFounderFallbackWakeEvent,
  parseFounderFallbackKey, registerFounderFallbackNoticeWork,
} from "../services/founder-fallback-notices.js";
import { OPERATOR_UNCONFIRMED_DELIVERY_CANCELLATION } from "../services/chat-publication-errors.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork, subscribeDeliveryWork } from "../services/delivery-work-notifications.js";
import { publishLiveEvent } from "../services/live-events.js";
import { idleWorkSnapshot, isIdleTaskDrainActive, startTaskDrain, stopTaskDrain } from "../services/task-admission.js";

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
      { endpointId, kind: "item", interactionId, attempt: 1 },
      { endpointId, kind: "agent", agentId, anchor: "terminated", attempt: 20 },
    ] as const) {
      const value = founderFallbackKey(key);
      expect(value.startsWith(FOUNDER_FALLBACK_KEY_PREFIX)).toBe(true);
      expect(isFounderFallbackPublication({ idempotencyKey: value })).toBe(true);
      expect(parseFounderFallbackKey(value)).toEqual(key);
    }
    for (const value of [
      `${FOUNDER_FALLBACK_KEY_PREFIX}${endpointId}:agent:${agentId}:error.x`,
      `${FOUNDER_FALLBACK_KEY_PREFIX}${endpointId}:item:${interactionId}:extra`,
      `${FOUNDER_FALLBACK_KEY_PREFIX}${endpointId}:item:${interactionId}:a0`,
      `${FOUNDER_FALLBACK_KEY_PREFIX}${endpointId}:item:${interactionId}:a1000`,
      `${FOUNDER_FALLBACK_KEY_PREFIX}${endpointId.toUpperCase()}:item:${interactionId}`,
      `founder-fallback:v2:${endpointId}:item:${interactionId}`,
      `fast-response:${interactionId}`,
    ]) expect(parseFounderFallbackKey(value)).toBeNull();
    expect(isFounderFallbackPublication({ idempotencyKey: `fast-response:${interactionId}` })).toBe(false);
  });

  it("treats only a pre-I/O cancellation as definitely unsent", () => {
    const base = { state: "cancelled", publishedAt: null, providerMessageId: null, redactedError: "Destination is disabled in Paperclip" } as const;
    expect(founderFallbackDefinitelyUnsent(base)).toBe(true);
    expect(founderFallbackDefinitelyUnsent({ ...base, redactedError: OPERATOR_UNCONFIRMED_DELIVERY_CANCELLATION })).toBe(false);
    expect(founderFallbackDefinitelyUnsent({ ...base, providerMessageId: "m-1" })).toBe(false);
    expect(founderFallbackDefinitelyUnsent({ ...base, publishedAt: new Date() })).toBe(false);
    for (const state of ["pending", "retry", "streaming", "published", "delivery_unknown", "failed", "awaiting_consent"] as const) {
      expect(founderFallbackDefinitelyUnsent({ ...base, state })).toBe(false);
    }
  });

  it("wakes only on agent, run, interaction and chat-configuration changes", () => {
    const activity = (payload: Record<string, unknown>) => ({ type: "activity.logged" as const, payload });
    expect(isFounderFallbackWakeEvent({ type: "agent.status", payload: {} })).toBe(true);
    expect(isFounderFallbackWakeEvent({ type: "heartbeat.run.status", payload: {} })).toBe(true);
    for (const action of ["issue.thread_interaction_created", "issue.interaction_cancelled", "agent.paused", "agent.resumed",
      "chat_endpoint.paused", "chat_endpoint.resumed", "chat.setup_completed", "company_member.updated"]) {
      expect(isFounderFallbackWakeEvent(activity({ action }))).toBe(true);
    }
    expect(isFounderFallbackWakeEvent(activity({ action: "anything", entityType: "agent" }))).toBe(true);
    expect(isFounderFallbackWakeEvent(activity({ action: "issue.comment_added", entityType: "issue" }))).toBe(false);
    expect(isFounderFallbackWakeEvent({ type: "heartbeat.run.log", payload: {} })).toBe(false);
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
    expect(await f.service.sweep()).toMatchObject({ targets: 1, inserted: 0 });
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
    expect(await f.service.sweep()).toMatchObject({ targets: 1, inserted: 3 });
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
    expect(await disabled.sweep()).toEqual({ targets: 0, inserted: 0, nextDueAt: null, awaitingOutbox: false });
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
    expect(await f.service.sweep()).toMatchObject({ targets: 0, inserted: 0 });
    await db.update(companyMemberships).set({ membershipRole: "owner" }).where(eq(companyMemberships.companyId, f.companyId));

    await addSender({ companyId: f.companyId, endpointId: f.endpointId, conversationId: f.conversationId,
      principalId: randomUUID(), userId: `someone-${randomUUID()}` });
    expect(await f.service.sweep()).toMatchObject({ targets: 0, inserted: 0 });

    expect(await rows(f)).toEqual([]);

    // Once every sender links to the founder again the notice goes out, and a
    // later revocation fails its transport re-proof.
    await db.update(chatIdentityLinks).set({ paperclipUserId: f.founderUserId }).where(eq(chatIdentityLinks.companyId, f.companyId));
    expect(await f.service.sweep()).toMatchObject({ targets: 1, inserted: 1 });
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

  it("flags an escalation the available agent never picked up on its task, and stays quiet once it does", async () => {
    const f = await fixture();
    const pickedUp = await interaction(f, { addresseeAgentId: f.agentId, title: "Picked-up escalation" });
    const unread = await interaction(f, { addresseeAgentId: f.agentId, title: "Unread escalation", createdAt: new Date(start.getTime() + MINUTE) });
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId: f.otherIssueId, status: "succeeded",
      createdAt: new Date(start.getTime() + 2 * MINUTE), startedAt: new Date(start.getTime() + 2 * MINUTE) });
    // A run on their task started after both escalations, so neither was missed.
    at(30);
    expect((await f.service.sweep()).inserted).toBe(0);

    // With the only task run between them, just the later escalation was missed.
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId: f.otherIssueId, status: "succeeded",
      createdAt: new Date(start.getTime() + MINUTE / 2), startedAt: new Date(start.getTime() + MINUTE / 2) });
    expect((await f.service.sweep()).inserted).toBe(1);
    const [notice] = await rows(f);
    expect(notice!.idempotencyKey).toBe(founderFallbackKey({ endpointId: f.endpointId, kind: "item", interactionId: unread.id }));
    expect(notice!.idempotencyKey).not.toContain(pickedUp.id);
    expect(text(notice!)).toContain("Master Builder has not started a run on that task since this escalation reached it 29 min ago.");

    // A run bound to the task through its context snapshot is pickup as well.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running", createdAt: now, startedAt: now,
      contextSnapshot: { issueId: f.otherIssueId } });
    expect(await f.service.authorizeFounderFallbackPublication(db, notice!)).toBe(false);
  });

  it("does not mistake runs on other tasks or on no task for pickup of the escalation", async () => {
    const f = await fixture();
    const escalation = await interaction(f, { addresseeAgentId: f.agentId, title: "Unhandled escalation" });
    // The same agent works its DM task and an unbound turn after the escalation reached it.
    for (const issueId of [f.dmIssueId, null]) {
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId, status: "succeeded",
        createdAt: new Date(start.getTime() + MINUTE), startedAt: new Date(start.getTime() + MINUTE),
        contextSnapshot: issueId ? { issueId } : {} });
    }
    at(30);
    expect((await f.service.sweep()).inserted).toBe(1);
    const key = founderFallbackKey({ endpointId: f.endpointId, kind: "item", interactionId: escalation.id });
    expect((await rows(f)).map(row => row.idempotencyKey)).toEqual([key]);

    // After a restart the still-pending escalation is not queued twice.
    const restarted = createFounderFallbackNotices(db, { enabled: true, boundMs: BOUND }, () => now);
    at(45);
    expect((await restarted.sweep()).inserted).toBe(0);
    expect(await rows(f)).toHaveLength(1);

    // Actual addressed pickup on the escalation's task withdraws the queued notice at its claim.
    const [notice] = await rows(f);
    expect(await restarted.authorizeFounderFallbackPublication(db, notice!)).toBe(true);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId: f.otherIssueId, status: "running",
      createdAt: now, startedAt: now });
    expect(await restarted.authorizeFounderFallbackPublication(db, notice!)).toBe(false);
  });

  it("re-arms an item cancelled before delivery when the same pending item qualifies again", async () => {
    const f = await fixture();
    const decision = await interaction(f, { addresseeUserId: f.founderUserId });
    await failAgent(f, start);
    at(21);
    await f.service.sweep();
    const notice = (await rows(f)).find(row => row.idempotencyKey.endsWith(decision.id))!;
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
    expect(await f.service.authorizeFounderFallbackPublication(db, notice)).toBe(false);
    // The native transport claim cancels each row that fails its re-proof before provider I/O.
    await db.update(chatPublications).set({ state: "cancelled", redactedError: "Task control requester or destination is no longer authorized" })
      .where(eq(chatPublications.companyId, f.companyId));
    at(30);
    await failAgent(f, now);
    at(40);
    // Not yet past the bound of the new outage: nothing re-armed early.
    expect((await f.service.sweep()).inserted).toBe(0);
    at(51);
    expect((await f.service.sweep()).inserted).toBe(2);
    const itemRows = (await rows(f)).filter(row => row.idempotencyKey.includes(decision.id));
    expect(itemRows.map(row => [row.idempotencyKey, row.state])).toEqual([
      [founderFallbackKey({ endpointId: f.endpointId, kind: "item", interactionId: decision.id }), "cancelled"],
      [founderFallbackKey({ endpointId: f.endpointId, kind: "item", interactionId: decision.id, attempt: 1 }), "pending"],
    ]);
    expect(await f.service.authorizeFounderFallbackPublication(db, itemRows[1]!)).toBe(true);
    at(60);
    expect((await f.service.sweep()).inserted).toBe(0);
  });

  it("re-arms a definitely-unsent agent notice once endpoint authority is restored within the same outage", async () => {
    const f = await fixture();
    await failAgent(f, start);
    at(21);
    await f.service.sweep();
    const [notice] = await rows(f);
    await db.update(chatEndpoints).set({ status: "paused" }).where(eq(chatEndpoints.id, f.endpointId));
    expect(await f.service.authorizeFounderFallbackPublication(db, notice!)).toBe(false);
    await db.update(chatPublications).set({ state: "cancelled", redactedError: "Destination is disabled in Paperclip" })
      .where(eq(chatPublications.id, notice!.id));
    expect((await f.service.sweep()).targets).toBe(0);
    await db.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, f.endpointId));
    at(25);
    expect((await f.service.sweep()).inserted).toBe(1);
    expect((await rows(f)).map(row => row.state)).toEqual(["cancelled", "pending"]);
    expect((await rows(f))[1]!.idempotencyKey).toBe(`${notice!.idempotencyKey}:a1`);
  });

  it("never re-arms a notice that may have reached the founder or failed", async () => {
    for (const outcome of [
      { state: "cancelled" as const, redactedError: OPERATOR_UNCONFIRMED_DELIVERY_CANCELLATION },
      { state: "cancelled" as const, providerMessageId: "provider-message" },
      { state: "delivery_unknown" as const },
      { state: "published" as const },
      { state: "failed" as const, redactedError: "Discord rejected the message" },
    ]) {
      const f = await fixture();
      const decision = await interaction(f, { addresseeUserId: f.founderUserId });
      await failAgent(f, start);
      at(21);
      await f.service.sweep();
      const notice = (await rows(f)).find(row => row.idempotencyKey.endsWith(decision.id))!;
      await db.update(chatPublications).set(outcome).where(eq(chatPublications.id, notice.id));
      at(40);
      expect((await f.service.sweep()).inserted).toBe(0);
      expect((await rows(f)).filter(row => row.idempotencyKey.includes(decision.id))).toHaveLength(1);
      for (const table of [chatPublications, chatDeliveries, chatIdentityLinks, chatExternalPrincipals, chatConversations,
        chatEndpoints, toolConnections, toolApplications, issueThreadInteractions, heartbeatRuns, issues, companyMemberships,
        agents, companies]) await db.delete(table);
    }
  });

  it("re-arms once under concurrent sweeps and restarts, and stops after the re-arm limit", async () => {
    const f = await fixture();
    const decision = await interaction(f, { addresseeUserId: f.founderUserId });
    await failAgent(f, start);
    at(21);
    await f.service.sweep();
    const base = founderFallbackKey({ endpointId: f.endpointId, kind: "item", interactionId: decision.id });
    const cancelAll = () => db.update(chatPublications).set({ state: "cancelled", redactedError: "Destination is disabled in Paperclip" })
      .where(like(chatPublications.idempotencyKey, `${base}%`));
    await cancelAll();
    const restarted = createFounderFallbackNotices(db, { enabled: true, boundMs: BOUND }, () => now);
    const results = await Promise.all([f.service.sweep(), restarted.sweep(), restarted.sweep()]);
    expect(results.reduce((sum, result) => sum + result.inserted, 0)).toBe(1);
    expect((await rows(f)).filter(row => row.idempotencyKey.startsWith(base)).map(row => row.idempotencyKey).sort())
      .toEqual([base, `${base}:a1`]);

    for (let attempt = 2; attempt <= MAX_FOUNDER_FALLBACK_REARMS; attempt += 1) {
      await cancelAll();
      expect((await restarted.sweep()).inserted).toBe(1);
    }
    await cancelAll();
    expect((await restarted.sweep()).inserted).toBe(0);
    const itemRows = (await rows(f)).filter(row => row.idempotencyKey.startsWith(base));
    expect(itemRows).toHaveLength(MAX_FOUNDER_FALLBACK_REARMS + 1);
    expect(itemRows.every(row => row.state === "cancelled")).toBe(true);
  });

  it("reports the real next deadline and no deadline when idle", async () => {
    const f = await fixture();
    expect(await f.service.sweep()).toEqual({ targets: 1, inserted: 0, nextDueAt: null, awaitingOutbox: false });
    await interaction(f, { addresseeUserId: f.founderUserId, createdAt: new Date(start.getTime() + 2 * MINUTE) });
    expect((await f.service.sweep()).nextDueAt).toBeNull();
    const escalation = await interaction(f, { addresseeAgentId: f.agentId, createdAt: new Date(start.getTime() + 3 * MINUTE) });
    at(10);
    expect((await f.service.sweep()).nextDueAt).toBe(escalation.createdAt.getTime() + BOUND);
    await failAgent(f, new Date(start.getTime() + 5 * MINUTE));
    // While the agent is down its bound replaces the escalation deadline.
    expect((await f.service.sweep()).nextDueAt).toBe(start.getTime() + 25 * MINUTE);
    at(26);
    const due = await f.service.sweep();
    expect(due).toMatchObject({ inserted: 3, nextDueAt: null });
    expect((await f.service.sweep())).toMatchObject({ inserted: 0, nextDueAt: null });
    // Recovery with the agent notice still queued waits for the outbox, not a timer.
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
    expect(await f.service.sweep()).toMatchObject({ inserted: 0, nextDueAt: null, awaitingOutbox: true });
  });

  it("stays idle without repeated sweeps and wakes on real producers and deadlines", async () => {
    const sweeps: { inserted: number }[] = [];
    const quiet = () => new Promise(resolve => setTimeout(resolve, 150));
    async function run(service: ReturnType<typeof createFounderFallbackNotices>, body: (wake: () => void) => Promise<void>) {
      sweeps.length = 0;
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      const wrapped = { ...service, sweep: async (signal?: AbortSignal) => { const result = await service.sweep(signal); sweeps.push(result); return result; } };
      const worker = registerFounderFallbackNoticeWork(coordinator, wrapped, () => true, 20, db);
      try {
        await worker.ready;
        await body(worker.wake);
      } finally {
        await worker.stop();
        await coordinator.stop();
      }
    }
    const real = (boundMs = BOUND) => createFounderFallbackNotices(db, { enabled: true, boundMs });

    // No configuration: one startup reconstruction, then quiet.
    await run(real(), async () => { await quiet(); expect(sweeps).toHaveLength(1); });

    // Configured and idle, then irrelevant and relevant producer events.
    const f = await fixture();
    await run(real(), async () => {
      await quiet();
      expect(sweeps).toHaveLength(1);
      publishLiveEvent({ companyId: f.companyId, type: "activity.logged", payload: { action: "issue.comment_added", entityType: "issue" } });
      await quiet();
      expect(sweeps).toHaveLength(1);
      publishLiveEvent({ companyId: f.companyId, type: "agent.status", payload: { agentId: f.agentId, status: "idle" } });
      await quiet();
      expect(sweeps).toHaveLength(2);
    });

    // A failure crosses the bound at its own deadline: one notice, then quiet.
    await failAgent(f, new Date());
    await run(real(120), async () => {
      await quiet();
      await quiet();
      // The notice's own outbox write settles while that sweep observes the
      // outbox, so one final sweep confirms nothing remains and stops.
      expect(sweeps.map(sweep => sweep.inserted)).toEqual([0, 1, 0]);
      await quiet();
      expect(sweeps).toHaveLength(3);
    });

    // Recovery with the notice in flight waits for that outbox row's settlement.
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
    await run(real(120), async () => {
      await quiet();
      expect(sweeps).toHaveLength(1);
      await db.transaction(async tx => {
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.chatPublications);
        await tx.update(chatPublications).set({ state: "published", publishedAt: new Date() })
          .where(like(chatPublications.idempotencyKey, `${FOUNDER_FALLBACK_KEY_PREFIX}%:agent:%`));
      });
      await quiet();
      // The recovery notice's own outbox write is the last hint observed, and
      // the sweep it triggers finds nothing in flight.
      expect(sweeps.map(sweep => sweep.inserted)).toEqual([0, 1, 0]);
      // Completed history alone keeps nothing scheduled, including outbox churn.
      await db.transaction(async tx => notifyDeliveryWork(tx, DELIVERY_QUEUES.chatPublications));
      await quiet();
      expect(sweeps).toHaveLength(3);
    });
    expect((await rows(f)).map(row => row.idempotencyKey.split(":")[3])).toEqual(["agent", "recovered"]);
  });

  describe("outbox settlement observation", () => {
    // A recovered agent whose notice is still in the outbox: the sweep reports
    // awaitingOutbox, and that row's settlement decides the recovery notice.
    async function inFlightRecovery() {
      const f = await fixture();
      await failAgent(f, start);
      at(21);
      expect((await f.service.sweep()).inserted).toBe(1);
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
      return f;
    }
    const settleAgentNotice = (f: { companyId: string }) => db.transaction(async tx => {
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.chatPublications);
      await tx.update(chatPublications).set({ state: "published", publishedAt: new Date() }).where(and(
        eq(chatPublications.companyId, f.companyId), like(chatPublications.idempotencyKey, `${FOUNDER_FALLBACK_KEY_PREFIX}%:agent:%`)));
    });
    const recovered = async (f: { companyId: string }) => (await rows(f)).filter(row => row.idempotencyKey.includes(":recovered:"));
    const quiet = () => new Promise(resolve => setTimeout(resolve, 150));

    function harness(service: ReturnType<typeof createFounderFallbackNotices>, hooks: {
      beforeRead?: () => Promise<void>; afterRead?: () => Promise<void>;
    } = {}) {
      const sweeps: { inserted: number; awaitingOutbox: boolean }[] = [];
      const errors: unknown[] = [];
      const observers = { live: 0, max: 0 };
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { errors.push(error); } });
      const wrapped = { ...service, sweep: async (signal?: AbortSignal) => {
        const before = hooks.beforeRead; hooks.beforeRead = undefined;
        await before?.();
        const result = await service.sweep(signal);
        sweeps.push(result);
        const after = hooks.afterRead; hooks.afterRead = undefined;
        await after?.();
        return result;
      } };
      const worker = registerFounderFallbackNoticeWork(coordinator, wrapped, () => true, 20, db, wake => {
        observers.live += 1;
        observers.max = Math.max(observers.max, observers.live);
        const off = subscribeDeliveryWork(db, DELIVERY_QUEUES.chatPublications, wake);
        return () => { observers.live -= 1; off(); };
      });
      return { worker, coordinator, sweeps, errors, observers, async close() { await worker.stop(); await coordinator.stop(); } };
    }

    it("recovers when the in-flight notice settles after the read but before the sweep returns", async () => {
      const f = await inFlightRecovery();
      const h = harness(f.service, { afterRead: () => settleAgentNotice(f) });
      try {
        await h.worker.ready;
        await vi.waitFor(async () => expect(await recovered(f)).toHaveLength(1), { timeout: 3000, interval: 25 });
        await quiet();
        expect(h.sweeps[0]).toMatchObject({ inserted: 0, awaitingOutbox: true });
        expect(h.sweeps.at(-1)).toMatchObject({ inserted: 0, awaitingOutbox: false });
        expect(h.sweeps.reduce((sum, sweep) => sum + sweep.inserted, 0)).toBe(1);
        expect(h.observers).toEqual({ live: 0, max: 1 });
        // Released after the final sweep: unrelated outbox churn no longer sweeps.
        const settled = h.sweeps.length;
        await db.transaction(async tx => notifyDeliveryWork(tx, DELIVERY_QUEUES.chatPublications));
        await quiet();
        expect(h.sweeps).toHaveLength(settled);
        expect(h.errors).toEqual([]);
      } finally {
        await h.close();
      }
      expect(await recovered(f)).toHaveLength(1);
    });

    it("recovers when the notice settled before the read, without any later hint", async () => {
      const f = await inFlightRecovery();
      const h = harness(f.service, { beforeRead: () => settleAgentNotice(f) });
      try {
        await h.worker.ready;
        await vi.waitFor(async () => expect(await recovered(f)).toHaveLength(1), { timeout: 3000, interval: 25 });
        await quiet();
        expect(h.sweeps[0]).toMatchObject({ inserted: 1, awaitingOutbox: false });
        expect(h.observers).toEqual({ live: 0, max: 1 });
        expect(h.errors).toEqual([]);
      } finally {
        await h.close();
      }
    });

    it("leaves no observer, deadline or later sweep when stopped during a sweep", async () => {
      const f = await inFlightRecovery();
      let release!: () => void;
      let reached!: () => void;
      const blocked = new Promise<void>(resolve => { reached = resolve; });
      const h = harness(f.service, { afterRead: () => { reached(); return new Promise<void>(resolve => { release = resolve; }); } });
      await blocked;
      const observedDuringSweep = h.observers.live;
      const stopping = h.worker.stop();
      const observedOnceStopping = h.observers.live;
      await settleAgentNotice(f);
      release();
      await stopping;
      // The late sweep result must not attach an observer after stop.
      expect(h.observers.live).toBe(0);
      await h.worker.stop();
      await h.coordinator.stop();
      await quiet();
      expect(h.observers.live).toBe(0);
      expect([observedDuringSweep, observedOnceStopping, h.observers.max]).toEqual([1, 0, 1]);
      expect(h.coordinator.nextWakeAt()).toBeNull();
      expect(h.sweeps).toEqual([expect.objectContaining({ awaitingOutbox: true })]);
      expect(await recovered(f)).toEqual([]);
    });

    it("never sweeps or observes when stopped before its first run", async () => {
      const f = await inFlightRecovery();
      const h = harness(f.service);
      await h.worker.stop();
      await h.worker.stop();
      await h.coordinator.stop();
      await quiet();
      expect(h.sweeps).toEqual([]);
      expect(h.observers).toEqual({ live: 0, max: 0 });
    });

    it("keeps the obligation through a failed sweep and releases the observer once it settles", async () => {
      const f = await inFlightRecovery();
      const h = harness(f.service, { beforeRead: async () => { throw new Error("transient read failure"); } });
      try {
        await vi.waitFor(() => expect(h.sweeps.length).toBeGreaterThanOrEqual(1), { timeout: 3000, interval: 10 });
        expect(h.errors).toHaveLength(1);
        expect(h.sweeps[0]).toMatchObject({ awaitingOutbox: true });
        expect(h.observers.live).toBe(1);
        await settleAgentNotice(f);
        await vi.waitFor(async () => expect(await recovered(f)).toHaveLength(1), { timeout: 3000, interval: 25 });
        await quiet();
        expect(h.sweeps.at(-1)).toMatchObject({ awaitingOutbox: false });
        expect(h.observers).toEqual({ live: 0, max: 1 });
        expect(h.errors).toHaveLength(1);
      } finally {
        await h.close();
      }
    });

    // The production predicates: idle drain reconciles without dispatching,
    // warm standby does neither. Neither may consume an owed sweep.
    describe("admission gates", () => {
      let standby = false;
      afterEach(() => { stopTaskDrain(); standby = false; });
      const open = () => !standby && !isIdleTaskDrainActive();

      function gated(service: ReturnType<typeof createFounderFallbackNotices>, retryMs: number, hooks: {
        beforeRead?: () => Promise<void>;
      } = {}) {
        const sweeps: { inserted: number; awaitingOutbox: boolean }[] = [];
        const errors: unknown[] = [];
        const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: open, canReconcile: () => !standby,
          onError: error => { errors.push(error); } });
        const wrapped = { ...service, sweep: async (signal?: AbortSignal) => {
          const before = hooks.beforeRead; hooks.beforeRead = undefined;
          await before?.();
          const result = await service.sweep(signal);
          sweeps.push(result);
          return result;
        } };
        const worker = registerFounderFallbackNoticeWork(coordinator, wrapped, open, retryMs, db);
        return { worker, coordinator, sweeps, errors, async close() { await worker.stop(); await coordinator.stop(); } };
      }

      async function settlesQuietly(h: ReturnType<typeof gated>) {
        await quiet();
        const settled = h.sweeps.length;
        await quiet();
        expect(h.sweeps).toHaveLength(settled);
        expect(h.sweeps.at(-1)).toMatchObject({ inserted: 0, awaitingOutbox: false });
        expect(h.coordinator.nextWakeAt()).toBeNull();
        expect(h.errors).toEqual([]);
      }

      // Reviewer fixture (STA-48 round 8), with the production retry interval
      // too: the end of the drain resumes the owed sweep, not a later retry.
      it.each([20, 60_000])("retains a settlement observed during idle drain until it ends (retry %ims)", async retryMs => {
        const f = await inFlightRecovery();
        const h = gated(f.service, retryMs);
        try {
          await h.worker.ready;
          expect(h.sweeps).toHaveLength(1);
          startTaskDrain({ purpose: "idle" });
          await settleAgentNotice(f);
          await quiet();
          expect(h.sweeps).toHaveLength(1);
          expect(await recovered(f)).toHaveLength(0);
          stopTaskDrain();
          await vi.waitFor(async () => expect(await recovered(f)).toHaveLength(1), { timeout: 3000, interval: 25 });
          await settlesQuietly(h);
        } finally {
          await h.close();
        }
      });

      it("retains the first relevant producer hint seen during idle drain", async () => {
        const f = await fixture();
        await failAgent(f, start);
        at(21);
        expect((await f.service.sweep()).inserted).toBe(1);
        await db.update(chatPublications).set({ state: "published", publishedAt: new Date() })
          .where(eq(chatPublications.companyId, f.companyId));
        const h = gated(f.service, 60_000);
        try {
          await h.worker.ready;
          expect(h.sweeps).toEqual([expect.objectContaining({ inserted: 0, awaitingOutbox: false })]);
          startTaskDrain({ purpose: "idle" });
          await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
          publishLiveEvent({ companyId: f.companyId, type: "agent.status", payload: { agentId: f.agentId, status: "idle" } });
          await quiet();
          expect(h.sweeps).toHaveLength(1);
          stopTaskDrain();
          await vi.waitFor(async () => expect(await recovered(f)).toHaveLength(1), { timeout: 3000, interval: 25 });
          await settlesQuietly(h);
        } finally {
          await h.close();
        }
      });

      it("keeps a failed sweep's obligation when its retry falls in idle drain", async () => {
        const f = await inFlightRecovery();
        const h = gated(f.service, 20, { beforeRead: async () => {
          startTaskDrain({ purpose: "idle" });
          throw new Error("transient read failure");
        } });
        try {
          await vi.waitFor(() => expect(h.errors).toHaveLength(1), { timeout: 3000, interval: 10 });
          await settleAgentNotice(f);
          await quiet();
          // Retries pass through the drain without reading.
          expect(h.sweeps).toEqual([]);
          expect(await recovered(f)).toHaveLength(0);
          stopTaskDrain();
          await vi.waitFor(async () => expect(await recovered(f)).toHaveLength(1), { timeout: 3000, interval: 25 });
          h.errors.length = 0;
          await settlesQuietly(h);
        } finally {
          await h.close();
        }
      });

      it("runs a deadline that falls due during idle drain once it ends", async () => {
        const f = await fixture();
        await failAgent(f, new Date());
        const service = createFounderFallbackNotices(db, { enabled: true, boundMs: 120 });
        const h = gated(service, 60_000);
        try {
          await h.worker.ready;
          expect(h.sweeps).toEqual([expect.objectContaining({ inserted: 0 })]);
          startTaskDrain({ purpose: "idle" });
          await quiet();
          await quiet();
          expect(h.sweeps).toHaveLength(1);
          stopTaskDrain();
          await vi.waitFor(() => expect(h.sweeps.map(sweep => sweep.inserted)).toContain(1), { timeout: 3000, interval: 25 });
          await settlesQuietly(h);
          expect((await rows(f)).map(row => row.idempotencyKey.split(":")[3])).toEqual(["agent"]);
        } finally {
          await h.close();
        }
      });

      it("retains a settlement observed during warm standby until it ends", async () => {
        const f = await inFlightRecovery();
        const h = gated(f.service, 20);
        try {
          await h.worker.ready;
          standby = true;
          await settleAgentNotice(f);
          await quiet();
          expect(h.sweeps).toHaveLength(1);
          expect(await recovered(f)).toHaveLength(0);
          standby = false;
          await vi.waitFor(async () => expect(await recovered(f)).toHaveLength(1), { timeout: 3000, interval: 25 });
          await settlesQuietly(h);
        } finally {
          await h.close();
        }
      });

      it("adds no sweep or tracked work to an idle probe when nothing is owed", async () => {
        const f = await fixture();
        const h = gated(f.service, 20);
        try {
          await h.worker.ready;
          await quiet();
          expect(h.sweeps).toHaveLength(1);
          const before = idleWorkSnapshot();
          startTaskDrain({ purpose: "idle" });
          await quiet();
          expect(idleWorkSnapshot()).toEqual(before);
          stopTaskDrain();
          await quiet();
          expect(idleWorkSnapshot()).toEqual(before);
          expect(h.sweeps).toHaveLength(1);
          expect(h.coordinator.nextWakeAt()).toBeNull();
        } finally {
          await h.close();
        }
      });
    });
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
