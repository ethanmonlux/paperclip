import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
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
  issueThreadInteractions,
  issueWorkProducts,
  issues,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import type { AttentionItem } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { founderNotificationRoutes } from "../routes/founder-notifications.js";
import { issueRoutes } from "../routes/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { issueService } from "../services/issues.js";
import {
  founderNotificationAttentionSource,
  withFounderOccurrenceFingerprints,
} from "../services/founder-notification-attention.js";
import {
  FOUNDER_NOTIFICATION_STALL_AFTER_MS_MIN,
} from "../services/founder-notification-policy.js";
import {
  acknowledgeFounderEpisode,
  authorizeFounderNotificationPublication,
  type FounderEpisodeRow,
  founderNotificationService,
  listFounderEpisodeViews,
  listFounderRoutes,
  reconcileFounderRoute,
  reportFounderDeliveryState,
  resolveFounderRouteTarget,
  upsertFounderRoute,
  updateFounderRoute,
} from "../services/founder-notifications.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { founderNotificationFixtures } from "./helpers/founder-notification-fixture.js";

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

  const { seed, addPrincipal, addDelivery, enabledRoute, attentionItem, founderPublications, episodes } =
    founderNotificationFixtures(() => db);

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

  it("refuses a founder publication at transport once its route, episode or destination no longer matches", async () => {
    const fixture = await seed();
    const route = await enabledRoute(fixture);
    const item = attentionItem(fixture, { sourceKind: "approval", dedupKey: `approval:${randomUUID()}` });
    await reconcileFounderRoute(db, route, [item], new Date());
    const [card] = await founderPublications(fixture.companyId);
    const authorize = (publication: typeof card) =>
      db.transaction((tx) => authorizeFounderNotificationPublication(tx as never, publication!));
    expect(await authorize(card)).toBe(true);

    expect(await authorize({ ...card!, conversationId: randomUUID() })).toBe(false);
    expect(await authorize({ ...card!, issueId: fixture.chatTask.id })).toBe(false);
    expect(await authorize({ ...card!, idempotencyKey: "founder-notification:not-an-episode" })).toBe(false);

    // A route flipped off without its quiesce step is still refused.
    await db.update(chatActions).set({ status: "disabled" }).where(eq(chatActions.id, route.id));
    expect(await authorize(card)).toBe(false);
    await db.update(chatActions).set({ status: "enabled" }).where(eq(chatActions.id, route.id));
    expect(await authorize(card)).toBe(true);

    const [episode] = await episodes(fixture.companyId);
    await db.update(chatActions).set({ status: "resolved" }).where(eq(chatActions.id, episode!.id));
    expect(await authorize(card)).toBe(false);
  });

  it("writes nothing when the route is disabled while a sweep's attention read is in flight", async () => {
    const fixture = await seed();
    const route = await enabledRoute(fixture, FOUNDER_NOTIFICATION_STALL_AFTER_MS_MIN);
    const decision = attentionItem(fixture, { sourceKind: "approval", dedupKey: `approval:${randomUUID()}` });
    let entered!: () => void;
    let release!: () => void;
    const inRead = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const service = founderNotificationService(db, {
      listAttention: async (companyId) => {
        if (companyId !== fixture.companyId) return [];
        entered();
        await gate;
        return [decision];
      },
    });
    const sweeping = service.sweep();
    await inRead;
    await updateFounderRoute(db, fixture.companyId, route.id, { enabled: false }, "owner-user");
    release();
    await sweeping;
    expect(await episodes(fixture.companyId)).toHaveLength(0);
    expect(await founderPublications(fixture.companyId, "founder-notification")).toHaveLength(0);

    // The open step has the same fence: a due episode is never published from
    // a stale route snapshot, even before disable's quiesce step reaches it.
    await updateFounderRoute(db, fixture.companyId, route.id, { enabled: true }, "owner-user");
    const [live] = await listFounderRoutes(db, fixture.companyId, { enabledOnly: true });
    const start = Date.parse("2026-10-31T12:00:00Z");
    const stall = attentionItem(fixture, {
      sourceKind: "failed_run",
      dedupKey: `run:${randomUUID()}`,
      subject: { kind: "run", id: randomUUID(), companyId: fixture.companyId, title: "Run failed", identifier: null, status: "failed", href: null },
    });
    await reconcileFounderRoute(db, live!, [stall], new Date(start));
    await db.update(chatActions).set({ status: "disabled" }).where(eq(chatActions.id, route.id));
    const result = await reconcileFounderRoute(db, live!, [stall], new Date(start + FOUNDER_NOTIFICATION_STALL_AFTER_MS_MIN));
    expect(result).toMatchObject({ opened: 0, routeChanged: true });
    expect(await founderPublications(fixture.companyId, "founder-notification")).toHaveLength(0);
    expect((await episodes(fixture.companyId)).map((row) => row.status)).toEqual(["observing"]);
  });

  it("never lets a stale delivery-state write erase an acknowledgement or a resolution", async () => {
    const fixture = await seed();
    const route = await enabledRoute(fixture);
    const acknowledged = attentionItem(fixture, { sourceKind: "approval", dedupKey: `approval:${randomUUID()}` });
    const resolved = attentionItem(fixture, { sourceKind: "decision", dedupKey: `decision:${randomUUID()}` });
    await reconcileFounderRoute(db, route, [acknowledged, resolved], new Date());
    const staleRows = (await episodes(fixture.companyId)) as FounderEpisodeRow[];
    const stale = (dedupKey: string) => staleRows.find((row) => row.payload.dedupKey === dedupKey)!;
    for (const row of staleRows) {
      await db.update(chatPublications).set({ state: "published", providerMessageId: `m-${row.id}` }).where(eq(chatPublications.id, row.payload.publicationId!));
    }

    // Acknowledgement commits after this pass read the episode.
    await db.transaction((tx) =>
      acknowledgeFounderEpisode(tx, { companyId: fixture.companyId, episodeId: stale(acknowledged.dedupKey).id, userId: fixture.founderUserId, via: "board" }),
    );
    await reportFounderDeliveryState(db, stale(acknowledged.dedupKey));
    const [ackAfter] = await db.select().from(chatActions).where(eq(chatActions.id, stale(acknowledged.dedupKey).id));
    expect(ackAfter!.payload).toMatchObject({
      acknowledgedByUserId: fixture.founderUserId,
      acknowledgedVia: "board",
      acknowledgedAt: expect.any(String),
      reportedDeliveryState: "published",
    });

    // Resolution commits after this pass read the episode.
    await reconcileFounderRoute(db, route, [acknowledged], new Date());
    await reportFounderDeliveryState(db, stale(resolved.dedupKey));
    const [resolvedAfter] = await db.select().from(chatActions).where(eq(chatActions.id, stale(resolved.dedupKey).id));
    expect(resolvedAfter).toMatchObject({
      status: "resolved",
      payload: { resolutionReason: "item_cleared", resolvedAt: expect.any(String), resolutionPublicationId: expect.any(String) },
    });
  });

  it("opens a new episode when a review clears and reopens between polls or across a restart", async () => {
    const fixture = await seed();
    await enabledRoute(fixture);
    const [review] = await db
      .insert(issues)
      .values({
        companyId: fixture.companyId,
        title: "Review the canary plan",
        status: "in_review",
        assigneeUserId: fixture.founderUserId,
        executionState: { status: "pending", currentStageId: "stage-review", lastDecisionId: null, changesRequestedCount: 0 },
      })
      .returning();
    const onlyThisCompany = (source: ReturnType<typeof founderNotificationAttentionSource>) =>
      (async (companyId, recipientUserId, actor) =>
        companyId === fixture.companyId ? source(companyId, recipientUserId, actor) : []) as typeof source;
    const reviewEpisodes = async () =>
      (await episodes(fixture.companyId))
        .filter((row) => row.payload.dedupKey === `review:${review!.id}`)
        .sort((a, b) => a.payload.occurrence - b.payload.occurrence)
        .map((row) => [row.payload.occurrence, row.status]);

    let service = founderNotificationService(db, { listAttention: onlyThisCompany(founderNotificationAttentionSource(db)) });
    await service.sweep();
    await service.sweep();
    expect(await reviewEpisodes()).toEqual([[1, "open"]]);

    // Changes were requested and the review reopened between two polls; no
    // poll ever observed it absent.
    const reopenAt = new Date(Date.now() + 1_000);
    await db.insert(activityLog).values({
      companyId: fixture.companyId,
      actorType: "user",
      actorId: fixture.founderUserId,
      action: "issue.updated",
      entityType: "issue",
      entityId: review!.id,
      details: { status: "in_review", _previous: { status: "in_progress" } },
      createdAt: reopenAt,
    });
    await service.sweep();
    expect(await reviewEpisodes()).toEqual([[1, "resolved"], [2, "open"]]);
    // A status echo while still in review is not a reopening.
    await db.insert(activityLog).values({
      companyId: fixture.companyId,
      actorType: "user",
      actorId: fixture.founderUserId,
      action: "issue.updated",
      entityType: "issue",
      entityId: review!.id,
      details: { status: "in_review" },
      createdAt: new Date(reopenAt.getTime() + 1_000),
    });
    await service.sweep();
    await service.sweep();
    expect(await reviewEpisodes()).toEqual([[1, "resolved"], [2, "open"]]);

    // The server is down while the review is sent back and reopened at a new
    // gate; the restarted sweep sees only the reopened review.
    await db
      .update(issues)
      .set({ executionState: { status: "pending", currentStageId: "stage-review", lastDecisionId: randomUUID(), changesRequestedCount: 1 } })
      .where(eq(issues.id, review!.id));
    service = founderNotificationService(db, { listAttention: onlyThisCompany(founderNotificationAttentionSource(db)) });
    await service.sweep();
    await service.sweep();
    expect(await reviewEpisodes()).toEqual([[1, "resolved"], [2, "resolved"], [3, "open"]]);
    // One card per occurrence; the superseded unsent cards were cancelled.
    expect(
      (await founderPublications(fixture.companyId))
        .filter((row) => row.issueId === review!.id)
        .map((row) => row.state)
        .sort(),
    ).toEqual(["cancelled", "cancelled", "pending"]);
    // The review never left the founder's desk, so nothing claims it did.
    expect(
      (await episodes(fixture.companyId))
        .filter((row) => row.payload.dedupKey === `review:${review!.id}` && row.status === "resolved")
        .map((row) => row.payload.resolutionReason),
    ).toEqual(["superseded", "superseded"]);
    expect(await founderPublications(fixture.companyId, "founder-notification-resolution:")).toHaveLength(0);

    // The head under review is part of the occurrence where the primary work
    // product records one: a new head at the same gate is a new occurrence,
    // and the same head observed again is not.
    const [workProduct] = await db
      .insert(issueWorkProducts)
      .values({
        companyId: fixture.companyId,
        issueId: review!.id,
        type: "pull_request",
        provider: "github",
        title: "Canary plan",
        status: "open",
        isPrimary: true,
        metadata: { repo: "example/repo", sha: "1111111111111111111111111111111111111111" },
      })
      .returning();
    await service.sweep();
    await service.sweep();
    expect(await reviewEpisodes()).toEqual([[1, "resolved"], [2, "resolved"], [3, "resolved"], [4, "open"]]);
    await db
      .update(issueWorkProducts)
      .set({ metadata: { repo: "example/repo", sha: "2222222222222222222222222222222222222222" }, updatedAt: new Date() })
      .where(eq(issueWorkProducts.id, workProduct!.id));
    await service.sweep();
    await service.sweep();
    expect(await reviewEpisodes()).toEqual([[1, "resolved"], [2, "resolved"], [3, "resolved"], [4, "resolved"], [5, "open"]]);
    await service.sweep();
    expect(await reviewEpisodes()).toHaveLength(5);
  });

  it("attaches occurrence identity only to reviews, never to a stalled blocker", async () => {
    const fixture = await seed();
    await db.update(issues).set({ blockedTransitionAt: new Date("2026-10-31T10:00:00Z") }).where(eq(issues.id, fixture.task.id));
    const blocker = attentionItem(fixture, { sourceKind: "blocker_attention", dedupKey: `blocker:${fixture.task.id}` });
    const review = attentionItem(fixture, { sourceKind: "review", dedupKey: `review:${fixture.task.id}` });
    const other = attentionItem(fixture, { sourceKind: "approval", dedupKey: `approval:${randomUUID()}` });
    const [blockerFact, reviewFact, otherFact] = await withFounderOccurrenceFingerprints(db, fixture.companyId, [blocker, review, other]);
    expect(blockerFact).toEqual(blocker);
    expect(reviewFact!.founderOccurrenceFingerprint).toMatch(/^[0-9a-f]{24}$/);
    expect(otherFact).toEqual(other);
  });

  /**
   * A blocker stall driven through native issue mutations, read by the real
   * complete attention source and reconciled by real sweeps. Date is faked so
   * native transition timestamps and sweep times share one clock.
   */
  async function blockerStallHarness(fixture: Awaited<ReturnType<typeof seed>>) {
    const S = FOUNDER_NOTIFICATION_STALL_AFTER_MS_MIN;
    const key = `blocker:${fixture.task.id}`;
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    const at = (multiple: number) => vi.setSystemTime(start + Math.round(multiple * S));
    const issueSvc = issueService(db);
    await issueSvc.update(fixture.task.id, { status: "todo" });
    const hold = async (id: string) => {
      await issueSvc.update(id, { status: "blocked", blockedByIssueIds: [fixture.task.id] });
    };
    const release = async (id: string) => {
      await issueSvc.update(id, { status: "todo", blockedByIssueIds: [] });
    };
    const dependent = async (title: string) => {
      const [row] = await db
        .insert(issues)
        .values({ companyId: fixture.companyId, title, status: "todo", assigneeAgentId: fixture.agentId })
        .returning();
      return row!.id;
    };
    const source = founderNotificationAttentionSource(db);
    const actor = {
      type: "board" as const,
      userId: fixture.founderUserId,
      companyIds: [fixture.companyId],
      memberships: [{ companyId: fixture.companyId, membershipRole: "owner" as const, status: "active" as const }],
      source: "session" as const,
    };
    const blockerFacts = async () =>
      (await source(fixture.companyId, fixture.founderUserId, actor)).filter((fact) => fact.dedupKey === key);
    let failSnapshots = false;
    const newService = () =>
      founderNotificationService(db, {
        sweepIntervalMs: S,
        listAttention: async (companyId, recipientUserId, sweepActor) => {
          if (companyId !== fixture.companyId) return [];
          if (failSnapshots) throw new Error("feed unavailable");
          return (await source(companyId, recipientUserId, sweepActor)).filter((fact) => fact.dedupKey === key);
        },
      });
    const blockerEpisodes = async () =>
      (await episodes(fixture.companyId))
        .filter((row) => row.payload.dedupKey === key)
        .sort((x, y) => x.payload.occurrence - y.payload.occurrence);
    const summary = async () =>
      (await blockerEpisodes()).map((row) => [row.payload.occurrence, row.status, row.payload.resolutionReason]);
    const cards = async () =>
      (await founderPublications(fixture.companyId)).map((row) => row.state).sort();
    const notices = async () => founderPublications(fixture.companyId, "founder-notification-resolution:");
    const tokens = async () =>
      (
        await db
          .select()
          .from(chatActions)
          .where(and(eq(chatActions.companyId, fixture.companyId), eq(chatActions.kind, "founder_notification_ack")))
      ).map((row) => [row.providerActionId, row.status]);
    const publishPending = async () => {
      const pending = (await founderPublications(fixture.companyId)).filter((row) => row.state === "pending");
      expect(pending).toHaveLength(1);
      await db.update(chatPublications).set({ state: "published", providerMessageId: randomUUID(), publishedAt: new Date() }).where(eq(chatPublications.id, pending[0]!.id));
    };
    return {
      S, at, hold, release, dependent, blockerFacts, newService, blockerEpisodes, summary, cards, notices, tokens, publishPending,
      setSnapshotFailure: (value: boolean) => { failSnapshots = value; },
    };
  }

  it("keeps one blocker episode through any hold turnover and starts a new one only after a sweep observes it clear", async () => {
    const fixture = await seed();
    await enabledRoute(fixture, FOUNDER_NOTIFICATION_STALL_AFTER_MS_MIN);
    try {
      const h = await blockerStallHarness(fixture);
      const [a, b, c, x, d, e] = [
        await h.dependent("Dependent A"), await h.dependent("Dependent B"), await h.dependent("Dependent C"),
        await h.dependent("Dependent X"), await h.dependent("Dependent D"), await h.dependent("Dependent E"),
      ];
      let service = h.newService();
      h.at(0);
      await h.hold(a);
      await service.sweep();
      h.at(0.1);
      await h.hold(b);
      h.at(1);
      await service.sweep();
      expect(await h.summary()).toEqual([[1, "open", null]]);
      await h.publishPending();
      const originalTokens = await h.tokens();
      expect(originalTokens).toHaveLength(1);
      expect(originalTokens[0]![1]).toBe("issued");
      const unchanged = async () => {
        expect(await h.blockerFacts()).toHaveLength(1);
        expect(await h.summary()).toEqual([[1, "open", null]]);
        expect(await h.cards()).toEqual(["published"]);
        expect(await h.notices()).toHaveLength(0);
        expect(await h.tokens()).toEqual(originalTokens);
      };

      // Round 2: releasing only the earliest dependent is progress.
      h.at(1.5);
      await h.release(a);
      h.at(2);
      await service.sweep();
      await unchanged();

      // Round 3: C is held while B is still held, then B is released, all
      // before the next poll.
      h.at(2.3);
      await h.hold(c);
      h.at(2.6);
      await h.release(b);
      h.at(3);
      await service.sweep();
      await unchanged();

      // Bridge: X is held while C is released and C is held again, then X is
      // released. X is never observed and C's hold restarted.
      h.at(3.2);
      await h.hold(x);
      h.at(3.4);
      await h.release(c);
      h.at(3.6);
      await h.hold(c);
      h.at(3.8);
      await h.release(x);
      h.at(4);
      await service.sweep();
      await unchanged();

      // A relation rewrite with no status change.
      h.at(4.5);
      await issueService(db).update(c, { blockedByIssueIds: [fixture.task.id] });
      h.at(5);
      await service.sweep();
      await unchanged();

      // Equal timestamps: two holds start and the last one ends at one instant.
      h.at(5.5);
      await h.hold(d);
      await h.hold(e);
      await h.release(c);
      h.at(6);
      await service.sweep();
      await unchanged();
      expect((await h.blockerEpisodes())[0]!.payload).toMatchObject({ observationGaps: 0, maxObservationGapMs: null });

      // Downtime: a restarted sweep continues the episode and records the
      // unobserved period instead of treating it as proof.
      service = h.newService();
      h.at(12);
      await service.sweep();
      await unchanged();
      // Failed snapshots resolve nothing; the next successful one records the
      // gap they left.
      h.setSnapshotFailure(true);
      h.at(13);
      await service.sweep();
      h.at(14);
      await service.sweep();
      h.setSnapshotFailure(false);
      h.at(15);
      await service.sweep();
      await unchanged();
      expect((await h.blockerEpisodes())[0]!.payload).toMatchObject({ observationGaps: 2, maxObservationGapMs: 6 * h.S });
      const [view] = await service.listEpisodes(fixture.companyId);
      expect(view).toMatchObject({ state: "open", observationGaps: 2, maxObservationGapMs: 6 * h.S });

      // The original card's outcome is now UNKNOWN. A real clear: every hold
      // is released and a complete sweep observes the fact absent.
      await db.update(chatPublications).set({ state: "delivery_unknown" }).where(and(eq(chatPublications.companyId, fixture.companyId), eq(chatPublications.state, "published")));
      h.at(15.5);
      await h.release(d);
      await h.release(e);
      expect(await h.blockerFacts()).toHaveLength(0);
      h.at(16);
      await service.sweep();
      expect(await h.summary()).toEqual([[1, "resolved", "item_cleared"]]);
      expect(await h.notices()).toHaveLength(1);
      expect(await h.cards()).toEqual(["delivery_unknown"]);
      expect((await h.tokens()).map(([, status]) => status)).toEqual(["expired"]);

      // The stall forms again: a new occurrence that waits out the persistence
      // bound, across a restart, then alerts exactly once.
      h.at(16.5);
      await h.hold(b);
      h.at(17);
      await service.sweep();
      h.at(17.5);
      service = h.newService();
      await service.sweep();
      expect(await h.summary()).toEqual([[1, "resolved", "item_cleared"], [2, "observing", null]]);
      expect(await h.cards()).toEqual(["delivery_unknown"]);
      h.at(18);
      await service.sweep();
      h.at(18.2);
      await service.sweep();
      expect(await h.summary()).toEqual([[1, "resolved", "item_cleared"], [2, "open", null]]);
      expect(await h.cards()).toEqual(["delivery_unknown", "pending"]);
      const [first, second] = await h.blockerEpisodes();
      expect(second!.payload.publicationId).not.toBe(first!.payload.publicationId);
      expect(second!.payload).toMatchObject({ observationGaps: 0, maxObservationGapMs: null });
      expect(await h.notices()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("judges terminal completion, cancellation and reopening only by what complete sweeps observe", async () => {
    const fixture = await seed();
    await enabledRoute(fixture, FOUNDER_NOTIFICATION_STALL_AFTER_MS_MIN);
    try {
      const h = await blockerStallHarness(fixture);
      const issueSvc = issueService(db);
      const b = await h.dependent("Dependent B");
      let service = h.newService();
      h.at(0);
      await h.hold(b);
      await service.sweep();
      h.at(1);
      await service.sweep();
      expect(await h.summary()).toEqual([[1, "open", null]]);
      await h.publishPending();

      // Cancelling the terminal does not resolve its dependents.
      h.at(1.5);
      await issueSvc.update(fixture.task.id, { status: "cancelled" });
      expect(await h.blockerFacts()).toHaveLength(1);
      h.at(2);
      await service.sweep();
      h.at(2.5);
      await issueSvc.update(fixture.task.id, { status: "todo" });
      h.at(3);
      await service.sweep();
      expect(await h.summary()).toEqual([[1, "open", null]]);
      expect(await h.cards()).toEqual(["published"]);

      // Completing the terminal clears the stall; a sweep observes it absent.
      h.at(3.5);
      await issueSvc.update(fixture.task.id, { status: "done" });
      expect(await h.blockerFacts()).toHaveLength(0);
      h.at(4);
      await service.sweep();
      expect(await h.summary()).toEqual([[1, "resolved", "item_cleared"]]);
      expect(await h.notices()).toHaveLength(1);

      // Reopening the terminal re-forms the stall as a new occurrence.
      h.at(4.5);
      await issueSvc.update(fixture.task.id, { status: "todo" });
      h.at(5);
      await service.sweep();
      h.at(6);
      await service.sweep();
      expect(await h.summary()).toEqual([[1, "resolved", "item_cleared"], [2, "open", null]]);
      expect(await h.cards()).toEqual(["pending", "published"]);
      await h.publishPending();

      // Done and reopened while the server is down: no sweep observed the
      // stall absent, so it is one episode with the unobserved period shown.
      h.at(6.5);
      await issueSvc.update(fixture.task.id, { status: "done" });
      h.at(7);
      await issueSvc.update(fixture.task.id, { status: "todo" });
      service = h.newService();
      h.at(12);
      await service.sweep();
      const all = await h.blockerEpisodes();
      expect(all.map((row) => [row.payload.occurrence, row.status])).toEqual([[1, "resolved"], [2, "open"]]);
      expect(all[1]!.payload).toMatchObject({ observationGaps: 1, maxObservationGapMs: 6 * h.S });
      expect(await h.cards()).toEqual(["published", "published"]);
      expect(await h.notices()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues blocker episodes from older payloads and under concurrent sweeps", async () => {
    const fixture = await seed();
    const S = FOUNDER_NOTIFICATION_STALL_AFTER_MS_MIN;
    const route = await enabledRoute(fixture, S);
    const stall = attentionItem(fixture, { sourceKind: "blocker_attention", dedupKey: `blocker:${fixture.task.id}`, relatedIssue: null, subject: { kind: "issue", id: fixture.task.id, companyId: fixture.companyId, title: fixture.task.title, identifier: fixture.task.identifier, status: "blocked", href: null } });
    const start = Date.parse("2026-10-31T10:00:00Z");
    const options = { sweepIntervalMs: 30_000 };

    // Overlapping first passes converge on one episode.
    await Promise.all([0, 1, 2].map(() => reconcileFounderRoute(db, route, [stall], new Date(start), options)));
    expect(await episodes(fixture.companyId)).toHaveLength(1);

    // An episode written before the gap fields existed, carrying an
    // equality fingerprint from an earlier build, reads as no gaps and
    // continues by presence.
    await db
      .update(chatActions)
      .set({ payload: sql`(${chatActions.payload} - 'observationGaps' - 'maxObservationGapMs') || '{"occurrenceFingerprint":"legacy-blocker-fingerprint"}'::jsonb` })
      .where(and(eq(chatActions.companyId, fixture.companyId), eq(chatActions.kind, "founder_notification_episode")));
    const [legacyView] = await listFounderEpisodeViews(db, fixture.companyId);
    expect(legacyView).toMatchObject({ state: "observing", observationGaps: 0, maxObservationGapMs: null });

    // Overlapping due passes send exactly one card.
    await Promise.all([0, 1, 2].map(() => reconcileFounderRoute(db, route, [stall], new Date(start + S), options)));
    expect(await founderPublications(fixture.companyId)).toHaveLength(1);
    await reconcileFounderRoute(db, route, [stall], new Date(start + 2 * S), options);
    const rows = await episodes(fixture.companyId);
    expect(rows.map((row) => [row.payload.occurrence, row.status])).toEqual([[1, "open"]]);
    expect(rows[0]!.payload).toMatchObject({ observationGaps: 2, maxObservationGapMs: S });
    expect(await founderPublications(fixture.companyId)).toHaveLength(1);
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
