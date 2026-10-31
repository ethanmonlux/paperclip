import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  authUsers,
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpoints,
  chatExternalPrincipals,
  chatIdentityLinks,
  chatPublications,
  companies,
  companyMemberships,
  createDb,
  issues,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import type { AttentionItem } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { founderNotificationRoutes } from "../routes/founder-notifications.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { founderNotificationAttentionSource } from "../services/founder-notification-attention.js";
import {
  FOUNDER_NOTIFICATION_STALL_AFTER_MS_MIN,
} from "../services/founder-notification-policy.js";
import {
  acknowledgeFounderEpisode,
  founderNotificationService,
  listFounderEpisodeViews,
  listFounderRoutes,
  reconcileFounderRoute,
  resolveFounderRouteTarget,
  upsertFounderRoute,
  updateFounderRoute,
} from "../services/founder-notifications.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("founder notifications", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousPublicUrl = process.env.PAPERCLIP_PUBLIC_URL;

  beforeAll(async () => {
    process.env.PAPERCLIP_PUBLIC_URL = "https://paperclip.example";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-founder-notifications-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    if (previousPublicUrl === undefined) delete process.env.PAPERCLIP_PUBLIC_URL;
    else process.env.PAPERCLIP_PUBLIC_URL = previousPublicUrl;
    await tempDb?.cleanup();
  });

  async function seed(options: { provider?: "telegram" | "slack"; publicationMode?: "automatic" | "explicit" } = {}) {
    const provider = options.provider ?? "telegram";
    const companyId = randomUUID();
    const agentId = randomUUID();
    const reviewerId = randomUUID();
    const founderUserId = `founder-${randomUUID()}`;
    const prefix = `FN${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: `Founder ${companyId}`, issuePrefix: prefix });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Engineer", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: reviewerId, companyId, name: "Reviewer", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    const now = new Date();
    await db.insert(authUsers).values({ id: founderUserId, name: "Founder", email: `${founderUserId}@example.com`, emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: founderUserId, status: "active", membershipRole: "owner" });
    const [chatTask] = await db.insert(issues).values({ companyId, title: "Founder DM chat", status: "done", assigneeAgentId: agentId }).returning();
    const [task] = await db
      .insert(issues)
      .values({ companyId, title: "Ship the notification canary", status: "blocked", assigneeAgentId: agentId, identifier: `${prefix}-7`, issueNumber: 7 })
      .returning();

    const applicationId = randomUUID();
    const connectionId = randomUUID();
    const endpointId = randomUUID();
    await db.insert(toolApplications).values({ id: applicationId, companyId, applicationKey: `chat:${provider}:${endpointId}`, name: provider, type: "chat", status: "active" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: `${provider} channel`, uid: `chat-${provider}-${endpointId}`, connectionPurpose: "channel", transport: "chat_sdk", status: "active", enabled: true });
    await db.insert(chatEndpoints).values({
      id: endpointId,
      companyId,
      connectionId,
      provider,
      publicId: randomUUID(),
      assignedAgentId: agentId,
      status: "active",
      publicationMode: options.publicationMode ?? "automatic",
      capabilities: {
        threads: true, directMessages: true, nativeStreaming: false, messageEdits: true, messageDeletes: false, reactions: true,
        files: true, cards: true, actions: true, modals: false, slashCommands: true, ephemeralMessages: false, proactiveDirectMessages: false,
      },
    });
    const [conversation] = await db
      .insert(chatConversations)
      .values({ companyId, endpointId, issueId: chatTask.id, externalConversationId: "founder-dm", externalThreadId: `${provider}:founder-dm`, externalLabel: "Founder", isDirectMessage: true, state: "completed" })
      .returning();
    const principal = await addPrincipal(companyId, endpointId, "founder-external", founderUserId);
    await addDelivery(companyId, endpointId, conversation.id, principal.id);
    return { companyId, agentId, reviewerId, founderUserId, task, chatTask, endpointId, conversation, principal };
  }

  async function addPrincipal(companyId: string, endpointId: string, externalId: string, linkedUserId: string | null) {
    const [principal] = await db
      .insert(chatExternalPrincipals)
      .values({ companyId, provider: "telegram", providerAccountId: "bot", externalId, kind: "user" })
      .returning();
    if (linkedUserId) {
      await db.insert(chatIdentityLinks).values({ companyId, endpointId, principalId: principal.id, paperclipUserId: linkedUserId, status: "linked", confirmedAt: new Date() });
    }
    return principal;
  }

  async function addDelivery(companyId: string, endpointId: string, conversationId: string, principalId: string) {
    await db.insert(chatDeliveries).values({
      companyId, endpointId, conversationId, principalId,
      providerEventId: randomUUID(), deduplicationKey: randomUUID(), eventKind: "direct_message", normalizedEvent: {}, state: "processed",
    });
  }

  async function enabledRoute(fixture: Awaited<ReturnType<typeof seed>>, stallAfterMs?: number) {
    await upsertFounderRoute(
      db,
      fixture.companyId,
      { recipientUserId: fixture.founderUserId, endpointId: fixture.endpointId, conversationId: fixture.conversation.id, enabled: true, stallAfterMs },
      "owner-user",
    );
    const [route] = await listFounderRoutes(db, fixture.companyId, { enabledOnly: true });
    return route!;
  }

  function attentionItem(
    fixture: Awaited<ReturnType<typeof seed>>,
    overrides: Partial<AttentionItem> & Pick<AttentionItem, "sourceKind" | "dedupKey">,
  ): AttentionItem {
    const subjectId = randomUUID();
    return {
      id: `${overrides.sourceKind}:${overrides.dedupKey}`,
      companyId: fixture.companyId,
      subject: { kind: "interaction", id: subjectId, companyId: fixture.companyId, title: "Approve the canary?", identifier: null, status: "pending", href: null, metadata: { kind: "request_confirmation" } },
      relatedIssue: { kind: "issue", id: fixture.task.id, companyId: fixture.companyId, title: fixture.task.title, identifier: fixture.task.identifier, status: fixture.task.status, href: null },
      whyNow: "ignored prose",
      decisionVerbs: [],
      inlineResolvable: true,
      entryRule: "",
      exitRule: "",
      dismissalKey: `attention:${overrides.dedupKey}`,
      dismissal: null,
      severity: "medium",
      rank: 1,
      activityAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      project: null,
      workspace: null,
      expiresAt: null,
      ruleKey: null,
      originAgentName: null,
      queues: [],
      shelf: false,
      retentionDays: 30,
      keep: false,
      archivedAt: null,
      retentionVersion: 0,
      decideBy: null,
      decideByAttribution: null,
      snoozedUntil: null,
      detail: null,
      trainingExampleId: null,
      ...overrides,
    } as AttentionItem;
  }

  async function founderPublications(companyId: string, prefix = "founder-notification:") {
    return db
      .select()
      .from(chatPublications)
      .where(and(eq(chatPublications.companyId, companyId), like(chatPublications.idempotencyKey, `${prefix}%`)));
  }

  async function episodes(companyId: string) {
    return db
      .select()
      .from(chatActions)
      .where(and(eq(chatActions.companyId, companyId), eq(chatActions.kind, "founder_notification_episode")));
  }

  it("verifies the recipient binding and refuses to enable an unverifiable route", async () => {
    const fixture = await seed();
    await expect(
      resolveFounderRouteTarget(db, { companyId: fixture.companyId, endpointId: fixture.endpointId, conversationId: fixture.conversation.id, recipientUserId: fixture.founderUserId }),
    ).resolves.toMatchObject({ binding: { verified: true }, conversation: { id: fixture.conversation.id } });

    // Someone else wrote into the same thread: the DM no longer proves a single recipient.
    const stranger = await addPrincipal(fixture.companyId, fixture.endpointId, "stranger", null);
    await addDelivery(fixture.companyId, fixture.endpointId, fixture.conversation.id, stranger.id);
    await expect(
      upsertFounderRoute(db, fixture.companyId, { recipientUserId: fixture.founderUserId, endpointId: fixture.endpointId, conversationId: fixture.conversation.id, enabled: true }, "owner-user"),
    ).rejects.toMatchObject({ status: 422 });
    const disabled = await upsertFounderRoute(
      db,
      fixture.companyId,
      { recipientUserId: fixture.founderUserId, endpointId: fixture.endpointId, conversationId: fixture.conversation.id, enabled: false },
      "owner-user",
    );
    expect(disabled).toMatchObject({ enabled: false, binding: { verified: false, reason: "foreign_participant" } });

    const other = await seed();
    await expect(
      resolveFounderRouteTarget(db, { companyId: other.companyId, endpointId: other.endpointId, conversationId: other.conversation.id, recipientUserId: "not-a-member" }),
    ).resolves.toMatchObject({ binding: { verified: false, reason: "foreign_participant" } });
    await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.principalId, other.founderUserId));
    await expect(
      resolveFounderRouteTarget(db, { companyId: other.companyId, endpointId: other.endpointId, conversationId: other.conversation.id, recipientUserId: other.founderUserId }),
    ).resolves.toMatchObject({ binding: { verified: false, reason: "recipient_not_member" } });

    const explicit = await seed({ publicationMode: "explicit" });
    await expect(
      resolveFounderRouteTarget(db, { companyId: explicit.companyId, endpointId: explicit.endpointId, conversationId: explicit.conversation.id, recipientUserId: explicit.founderUserId }),
    ).resolves.toMatchObject({ binding: { verified: false, reason: "endpoint_unavailable" } });
  });

  it("follows the DM thread to its newest sendable generation after /new", async () => {
    const fixture = await seed();
    await db.insert(chatPublications).values({
      companyId: fixture.companyId, endpointId: fixture.endpointId, conversationId: fixture.conversation.id, issueId: fixture.chatTask.id,
      idempotencyKey: `control:new:${randomUUID()}`, payload: { text: "Started a new task." }, state: "published",
    });
    await expect(
      resolveFounderRouteTarget(db, { companyId: fixture.companyId, endpointId: fixture.endpointId, conversationId: fixture.conversation.id, recipientUserId: fixture.founderUserId }),
    ).resolves.toMatchObject({ binding: { verified: false, reason: "conversation_unavailable" } });
    const [nextTask] = await db.insert(issues).values({ companyId: fixture.companyId, title: "Next chat", status: "todo" }).returning();
    const [next] = await db
      .insert(chatConversations)
      .values({
        companyId: fixture.companyId, endpointId: fixture.endpointId, issueId: nextTask.id, externalConversationId: "founder-dm",
        externalThreadId: fixture.conversation.externalThreadId, externalLabel: "Founder", isDirectMessage: true, state: "active", sessionGeneration: 2,
      })
      .returning();
    await expect(
      resolveFounderRouteTarget(db, { companyId: fixture.companyId, endpointId: fixture.endpointId, conversationId: fixture.conversation.id, recipientUserId: fixture.founderUserId }),
    ).resolves.toMatchObject({ binding: { verified: true }, conversation: { id: next.id } });
  });

  it("opens one attributed decision card, converges across passes and restarts, and never changes the task", async () => {
    const fixture = await seed();
    const route = await enabledRoute(fixture);
    const item = attentionItem(fixture, { sourceKind: "issue_thread_interaction", dedupKey: `interaction:${randomUUID()}` });

    const first = await reconcileFounderRoute(db, route, [item], new Date());
    expect(first).toMatchObject({ observed: 1, opened: 1 });
    // Repeated ticks, an overlapping pass and a fresh service (restart) converge.
    await Promise.all([
      reconcileFounderRoute(db, route, [item], new Date()),
      reconcileFounderRoute(db, route, [item], new Date()),
    ]);
    const [restartedRoute] = await listFounderRoutes(db, fixture.companyId, { enabledOnly: true });
    await reconcileFounderRoute(db, restartedRoute!, [item], new Date());

    const publications = await founderPublications(fixture.companyId);
    expect(publications).toHaveLength(1);
    expect(publications[0]).toMatchObject({
      state: "pending",
      issueId: fixture.task.id,
      endpointId: fixture.endpointId,
      conversationId: fixture.conversation.id,
    });
    const card = publications[0]!.payload.card!;
    expect(card.title).toBe(`${fixture.task.identifier}: Decision needs you`);
    expect(card.body).toContain("Ship the notification canary");
    expect(card.body).toContain("Approve the canary?");
    expect(card.body).toContain(`Messages typed in this chat are not delivered to ${fixture.task.identifier}.`);
    expect(publications[0]!.payload.text).toContain(`https://paperclip.example/issues/${fixture.task.id}`);
    expect(JSON.stringify(publications[0]!.payload)).not.toContain("ignored prose");
    expect(card.actions).toEqual([
      { type: "link", label: "Open in Paperclip", url: `https://paperclip.example/issues/${fixture.task.id}` },
      expect.objectContaining({ type: "callback", label: "Acknowledge" }),
    ]);
    const rows = await episodes(fixture.companyId);
    expect(rows).toHaveLength(1);
    expect(publications[0]!.payload.interactionId).toBe(rows[0]!.id);
    expect(rows[0]).toMatchObject({ status: "open", payload: { issueId: fixture.task.id, recipientUserId: fixture.founderUserId, occurrence: 1 } });
    const acks = await db.select().from(chatActions).where(and(eq(chatActions.companyId, fixture.companyId), eq(chatActions.kind, "founder_notification_ack")));
    expect(acks).toHaveLength(1);
    expect(acks[0]!.providerActionId.startsWith("pcf:")).toBe(true);

    const [taskAfter] = await db.select().from(issues).where(eq(issues.id, fixture.task.id));
    expect(taskAfter).toMatchObject({ status: "blocked", assigneeAgentId: fixture.agentId });
  });

  it("stays quiet for out-of-scope, snoozed and dismissed facts and holds stalls until the persistence bound", async () => {
    const fixture = await seed();
    const route = await enabledRoute(fixture, FOUNDER_NOTIFICATION_STALL_AFTER_MS_MIN);
    const start = Date.parse("2026-10-31T12:00:00Z");
    const quiet = [
      attentionItem(fixture, { sourceKind: "budget_alert", dedupKey: `budget:${randomUUID()}`, relatedIssue: null }),
      attentionItem(fixture, { sourceKind: "agent_error_alert", dedupKey: `agent_error:${randomUUID()}` }),
      attentionItem(fixture, { sourceKind: "approval", dedupKey: `approval:${randomUUID()}`, snoozedUntil: new Date(start + 3_600_000).toISOString() }),
      attentionItem(fixture, { sourceKind: "decision", dedupKey: `decision:${randomUUID()}`, dismissal: { kind: "dismissed" as never, dismissedAt: new Date(start).toISOString(), snoozedUntil: null, isActive: true } }),
    ];
    const stall = attentionItem(fixture, {
      sourceKind: "failed_run",
      dedupKey: `run:${randomUUID()}`,
      subject: { kind: "run", id: randomUUID(), companyId: fixture.companyId, title: "Run failed", identifier: null, status: "failed", href: null },
    });

    await reconcileFounderRoute(db, route, [...quiet, stall], new Date(start));
    await reconcileFounderRoute(db, route, [...quiet, stall], new Date(start + 60_000));
    expect(await founderPublications(fixture.companyId)).toHaveLength(0);
    // Two observations but under the bound: still silent.
    await reconcileFounderRoute(db, route, [...quiet, stall], new Date(start + FOUNDER_NOTIFICATION_STALL_AFTER_MS_MIN - 1));
    expect(await founderPublications(fixture.companyId)).toHaveLength(0);
    await reconcileFounderRoute(db, route, [...quiet, stall], new Date(start + FOUNDER_NOTIFICATION_STALL_AFTER_MS_MIN));
    const publications = await founderPublications(fixture.companyId);
    expect(publications).toHaveLength(1);
    expect(publications[0]!.payload.card?.title).toBe(`${fixture.task.identifier}: Stalled: latest run failed`);
    expect(publications[0]!.payload.card?.body).toContain("not recovered automatically for at least 5 minutes");
    expect((await episodes(fixture.companyId)).map((row) => row.payload.sourceKind)).toEqual(["failed_run"]);
  });

  it("resolves a stall that recovers before the bound without any message", async () => {
    const fixture = await seed();
    const route = await enabledRoute(fixture);
    const stall = attentionItem(fixture, { sourceKind: "blocker_attention", dedupKey: `blocker:${fixture.task.id}`, relatedIssue: null, subject: { kind: "issue", id: fixture.task.id, companyId: fixture.companyId, title: fixture.task.title, identifier: fixture.task.identifier, status: "blocked", href: null } });
    await reconcileFounderRoute(db, route, [stall], new Date());
    await reconcileFounderRoute(db, route, [stall], new Date());
    const cleared = await reconcileFounderRoute(db, route, [], new Date());
    expect(cleared).toMatchObject({ resolved: 1, resolutionNotices: 0 });
    expect(await founderPublications(fixture.companyId, "founder-notification")).toHaveLength(0);
    expect((await episodes(fixture.companyId))[0]).toMatchObject({ status: "resolved", payload: { resolutionReason: "cleared_before_notification" } });
  });

  it("cancels an unsent card on resolution and sends one notice for a visible or ambiguous one", async () => {
    const fixture = await seed();
    const route = await enabledRoute(fixture);
    const unsent = attentionItem(fixture, { sourceKind: "approval", dedupKey: `approval:${randomUUID()}` });
    const visible = attentionItem(fixture, { sourceKind: "review", dedupKey: `review:${randomUUID()}` });
    const ambiguous = attentionItem(fixture, { sourceKind: "decision", dedupKey: `decision:${randomUUID()}` });
    await reconcileFounderRoute(db, route, [unsent, visible, ambiguous], new Date());
    const cards = await founderPublications(fixture.companyId);
    expect(cards).toHaveLength(3);
    const episodeRows = await episodes(fixture.companyId);
    const publicationFor = (dedupKey: string) => {
      const episode = episodeRows.find((row) => row.payload.dedupKey === dedupKey)!;
      return cards.find((card) => card.id === episode.payload.publicationId)!;
    };
    await db.update(chatPublications).set({ state: "published", providerMessageId: "m-1", publishedAt: new Date() }).where(eq(chatPublications.id, publicationFor(visible.dedupKey).id));
    await db.update(chatPublications).set({ state: "delivery_unknown", attempts: 1 }).where(eq(chatPublications.id, publicationFor(ambiguous.dedupKey).id));

    // An ambiguous card is never resent by later passes.
    await reconcileFounderRoute(db, route, [unsent, visible, ambiguous], new Date());
    await reconcileFounderRoute(db, route, [unsent, visible, ambiguous], new Date());
    expect(await founderPublications(fixture.companyId)).toHaveLength(3);
    const [ambiguousEpisode] = (await episodes(fixture.companyId)).filter((row) => row.payload.dedupKey === ambiguous.dedupKey);
    expect(ambiguousEpisode!.payload.reportedDeliveryState).toBe("delivery_unknown");

    const result = await reconcileFounderRoute(db, route, [], new Date());
    expect(result).toMatchObject({ resolved: 3, resolutionNotices: 2 });
    const [unsentAfter] = await db.select().from(chatPublications).where(eq(chatPublications.id, publicationFor(unsent.dedupKey).id));
    expect(unsentAfter).toMatchObject({ state: "cancelled" });
    const notices = await founderPublications(fixture.companyId, "founder-notification-resolution:");
    expect(notices).toHaveLength(2);
    expect(notices.every((notice) => notice.issueId === fixture.task.id && notice.payload.text.startsWith(`Resolved: ${fixture.task.identifier}`))).toBe(true);
    const tokens = await db.select().from(chatActions).where(and(eq(chatActions.companyId, fixture.companyId), eq(chatActions.kind, "founder_notification_ack")));
    expect(tokens.every((token) => token.status === "expired")).toBe(true);
    // Resolution is idempotent.
    await reconcileFounderRoute(db, route, [], new Date());
    expect(await founderPublications(fixture.companyId, "founder-notification-resolution:")).toHaveLength(2);
  });

  it("opens a distinct episode when the same fact reopens after it cleared", async () => {
    const fixture = await seed();
    const route = await enabledRoute(fixture);
    const review = attentionItem(fixture, { sourceKind: "review", dedupKey: `review:${randomUUID()}` });
    await reconcileFounderRoute(db, route, [review], new Date());
    await reconcileFounderRoute(db, route, [], new Date());
    await reconcileFounderRoute(db, route, [review], new Date());
    await reconcileFounderRoute(db, route, [review], new Date());
    const rows = (await episodes(fixture.companyId)).sort((a, b) => a.payload.occurrence - b.payload.occurrence);
    expect(rows.map((row) => [row.payload.occurrence, row.status])).toEqual([[1, "resolved"], [2, "open"]]);
    expect(await founderPublications(fixture.companyId)).toHaveLength(2);
  });

  it("keeps a due episode observing while the route cannot deliver, then sends once repaired", async () => {
    const fixture = await seed();
    const route = await enabledRoute(fixture);
    await db.update(chatEndpoints).set({ status: "paused" }).where(eq(chatEndpoints.id, fixture.endpointId));
    const item = attentionItem(fixture, { sourceKind: "recovery_action", dedupKey: `recovery:x:${fixture.task.id}:c:f` });
    const service = founderNotificationService(db, { listAttention: async (companyId) => (companyId === fixture.companyId ? [item] : []) });
    expect(await reconcileFounderRoute(db, route, [item], new Date())).toMatchObject({ opened: 0, routeUnavailable: "endpoint_unavailable" });
    expect(await founderPublications(fixture.companyId)).toHaveLength(0);
    expect((await episodes(fixture.companyId))[0]).toMatchObject({ status: "observing" });

    await db.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, fixture.endpointId));
    await service.sweep();
    expect(await founderPublications(fixture.companyId)).toHaveLength(1);
    const [routeView] = await service.listRoutes(fixture.companyId);
    expect(routeView).toMatchObject({ enabled: true, lastUnavailableReason: null, binding: { verified: true } });
  });

  it("disabling a route cancels unsent cards and stops the sweep", async () => {
    const fixture = await seed();
    const route = await enabledRoute(fixture);
    const item = attentionItem(fixture, { sourceKind: "approval", dedupKey: `approval:${randomUUID()}` });
    await reconcileFounderRoute(db, route, [item], new Date());
    await updateFounderRoute(db, fixture.companyId, route.id, { enabled: false }, "owner-user");
    expect((await founderPublications(fixture.companyId))[0]).toMatchObject({ state: "cancelled" });
    let snapshots = 0;
    const service = founderNotificationService(db, {
      listAttention: async (companyId) => {
        if (companyId !== fixture.companyId) return [];
        snapshots += 1;
        return [item];
      },
    });
    await service.sweep();
    expect(snapshots).toBe(0);
    expect((await episodes(fixture.companyId))[0]).toMatchObject({ status: "resolved", payload: { resolutionReason: "route_disabled" } });
    const tokens = await db.select().from(chatActions).where(and(eq(chatActions.companyId, fixture.companyId), eq(chatActions.kind, "founder_notification_ack")));
    expect(tokens.map((token) => token.status)).toEqual(["expired"]);

    // Re-enabling starts clean: the still-present fact is sent again once.
    await updateFounderRoute(db, fixture.companyId, route.id, { enabled: true }, "owner-user");
    await service.sweep();
    await service.sweep();
    expect(snapshots).toBe(2);
    const cards = await founderPublications(fixture.companyId);
    expect(cards.map((card) => card.state).sort()).toEqual(["cancelled", "pending"]);
    const rows = (await episodes(fixture.companyId)).sort((a, b) => a.payload.occurrence - b.payload.occurrence);
    expect(rows.map((row) => [row.payload.occurrence, row.status])).toEqual([[1, "resolved"], [2, "open"]]);
  });

  it("never resolves facts when the attention snapshot fails", async () => {
    const fixture = await seed();
    const route = await enabledRoute(fixture);
    const item = attentionItem(fixture, { sourceKind: "approval", dedupKey: `approval:${randomUUID()}` });
    await reconcileFounderRoute(db, route, [item], new Date());
    const service = founderNotificationService(db, {
      listAttention: async (companyId) => {
        if (companyId === fixture.companyId) throw new Error("feed unavailable");
        return [];
      },
    });
    await service.sweep();
    expect((await episodes(fixture.companyId))[0]).toMatchObject({ status: "open" });
  });

  it("acknowledges only for the recipient, once, without resolving the decision", async () => {
    const fixture = await seed();
    const route = await enabledRoute(fixture);
    const item = attentionItem(fixture, { sourceKind: "issue_thread_interaction", dedupKey: `interaction:${randomUUID()}` });
    await reconcileFounderRoute(db, route, [item], new Date());
    const [episode] = await episodes(fixture.companyId);
    await expect(
      db.transaction((tx) => acknowledgeFounderEpisode(tx, { companyId: fixture.companyId, episodeId: episode!.id, userId: "someone-else", via: "board" })),
    ).rejects.toMatchObject({ status: 403 });
    await db.update(chatPublications).set({ state: "published", providerMessageId: "m-1" }).where(eq(chatPublications.id, episode!.payload.publicationId!));
    const service = founderNotificationService(db, { listAttention: async (companyId) => (companyId === fixture.companyId ? [item] : []) });
    expect((await service.acknowledge(fixture.companyId, episode!.id, fixture.founderUserId)).acknowledged).toBe(true);
    expect((await service.acknowledge(fixture.companyId, episode!.id, fixture.founderUserId)).acknowledged).toBe(false);
    const [after] = await db.select().from(chatActions).where(eq(chatActions.id, episode!.id));
    expect(after).toMatchObject({ status: "open", payload: { acknowledgedByUserId: fixture.founderUserId, acknowledgedVia: "board" } });
    expect(await founderPublications(fixture.companyId, "founder-notification-ack:")).toHaveLength(1);
    const [view] = await listFounderEpisodeViews(db, fixture.companyId);
    expect(view).toMatchObject({ state: "open", acknowledgedAt: expect.any(String), delivery: { state: "published" } });
  });

  it("keeps secrets out of durable state and redacts them from the provider card", async () => {
    const fixture = await seed();
    const route = await enabledRoute(fixture);
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const item = attentionItem(fixture, {
      sourceKind: "issue_thread_interaction",
      dedupKey: `interaction:${randomUUID()}`,
      subject: { kind: "interaction", id: randomUUID(), companyId: fixture.companyId, title: `Rotate token=${secret}?`, identifier: null, status: "pending", href: null },
    });
    await reconcileFounderRoute(db, route, [item], new Date());
    const [episode] = await episodes(fixture.companyId);
    expect(JSON.stringify(episode)).not.toContain(secret);
    const [card] = await founderPublications(fixture.companyId);
    expect(JSON.stringify(card!.payload)).not.toContain(secret);
  });

  it("notifies a real founder-addressed confirmation, stays quiet for agent routing cards, and settles when the same task is answered", async () => {
    const fixture = await seed();
    const route = await enabledRoute(fixture);
    const interactions = issueThreadInteractionService(db);
    const founderCard = await interactions.create(
      { id: fixture.task.id, companyId: fixture.companyId },
      {
        kind: "request_confirmation",
        continuationPolicy: "wake_assignee",
        title: "Canary go/no-go",
        payload: { version: 1, prompt: "Proceed with the phone canary?" },
      },
      { agentId: fixture.agentId },
    );
    // Agent-to-agent routing lives on its own task and must stay quiet.
    const [reviewTask] = await db
      .insert(issues)
      .values({ companyId: fixture.companyId, title: "Independent review", status: "in_review", assigneeAgentId: fixture.agentId })
      .returning();
    await interactions.create(
      { id: reviewTask!.id, companyId: fixture.companyId },
      {
        kind: "request_confirmation",
        continuationPolicy: "wake_assignee",
        title: "Route review",
        addresseeAgentId: fixture.reviewerId,
        payload: { version: 1, prompt: "Route the independent review?" },
      },
      { agentId: fixture.agentId },
    );
    const service = founderNotificationService(db, { listAttention: founderNotificationAttentionSource(db) });
    await service.sweep();
    const cards = await founderPublications(fixture.companyId);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ issueId: fixture.task.id });
    const rows = await episodes(fixture.companyId);
    // The founder decision opens at once; the blocked task's stall is only
    // observed under its bound; the agent routing card never appears.
    expect(rows.filter((row) => row.status === "open").map((row) => row.payload.dedupKey)).toEqual([`interaction:${founderCard.id}`]);
    expect(rows.filter((row) => row.status !== "open").map((row) => [row.payload.sourceKind, row.status])).toEqual([["blocker_attention", "observing"]]);
    expect(rows.every((row) => row.payload.issueId !== reviewTask!.id)).toBe(true);
    await db.update(chatPublications).set({ state: "published", providerMessageId: "m-1" }).where(eq(chatPublications.id, cards[0]!.id));

    const [task] = await db.select().from(issues).where(eq(issues.id, fixture.task.id));
    const accepted = await interactions.acceptInteraction(task!, founderCard.id, {}, { userId: fixture.founderUserId });
    // The answer resolves the card on the same original task; its native
    // wake_assignee continuation (not this feature) resumes that task.
    expect(accepted.interaction).toMatchObject({ status: "accepted", issueId: fixture.task.id, continuationPolicy: "wake_assignee", resolvedByUserId: fixture.founderUserId });
    await service.sweep();
    const notices = await founderPublications(fixture.companyId, "founder-notification-resolution:");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ issueId: fixture.task.id });
  });

  it("lets board members read state, only connection managers change routes, and only the recipient acknowledge", async () => {
    const fixture = await seed();
    const route = await enabledRoute(fixture);
    const item = attentionItem(fixture, { sourceKind: "approval", dedupKey: `approval:${randomUUID()}` });
    await reconcileFounderRoute(db, route, [item], new Date());
    const [episode] = await episodes(fixture.companyId);
    function app(actor: Record<string, unknown>) {
      const testApp = express();
      testApp.use(express.json());
      testApp.use((req, _res, next) => {
        (req as any).actor = actor;
        next();
      });
      testApp.use("/api", founderNotificationRoutes(db, founderNotificationService(db, { listAttention: async () => [] })));
      testApp.use(errorHandler);
      return testApp;
    }
    const member = (userId: string) => ({
      type: "board",
      source: "session",
      userId,
      companyIds: [fixture.companyId],
      memberships: [{ companyId: fixture.companyId, membershipRole: "operator", status: "active" }],
      isInstanceAdmin: false,
    });
    const agent = { type: "agent", source: "agent_key", companyId: fixture.companyId, agentId: fixture.agentId, runId: null };
    const base = `/api/companies/${fixture.companyId}/founder-notifications`;

    const read = await request(app(member("viewer-user"))).get(base).expect(200);
    expect(read.body.routes).toEqual([expect.objectContaining({ id: route.id, enabled: true, binding: { verified: true } })]);
    expect(read.body.episodes).toEqual([
      expect.objectContaining({ id: episode!.id, issueId: fixture.task.id, state: "open", delivery: expect.objectContaining({ state: "pending" }) }),
    ]);
    expect(JSON.stringify(read.body)).not.toMatch(/token|secret/i);
    await request(app(agent)).get(base).expect(403);
    await request(app(member("viewer-user"))).patch(`${base}/routes/${route.id}`).send({ enabled: false }).expect(403);
    await request(app(agent)).patch(`${base}/routes/${route.id}`).send({ enabled: false }).expect(403);
    await request(app(member("viewer-user"))).post(`${base}/episodes/${episode!.id}/acknowledge`).expect(403);
    await request(app(agent)).post(`${base}/episodes/${episode!.id}/acknowledge`).expect(403);
    const acknowledged = await request(app(member(fixture.founderUserId))).post(`${base}/episodes/${episode!.id}/acknowledge`).expect(200);
    expect(acknowledged.body).toMatchObject({ acknowledged: true, acknowledgedAt: expect.any(String) });

    const admin = { ...member("admin-user"), isInstanceAdmin: true };
    const disabled = await request(app(admin)).patch(`${base}/routes/${route.id}`).send({ enabled: false }).expect(200);
    expect(disabled.body).toMatchObject({ id: route.id, enabled: false });
    await request(app(admin)).patch(`${base}/routes/${route.id}`).send({ stallAfterMs: 1 }).expect(400);
  });
});
