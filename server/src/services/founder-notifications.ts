import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, like, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpoints,
  chatExternalPrincipals,
  chatIdentityLinks,
  chatPublications,
  companyMemberships,
} from "@paperclipai/db";
import type {
  AttentionItem,
  FounderNotificationDeliveryState,
  FounderNotificationEpisode,
  FounderNotificationRoute,
  FounderNotificationRouteUnavailableReason,
  SafeExternalChatCardAction,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { AuthorizationActor } from "./authorization.js";
import {
  TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
  telegramCallbackDataByteLength,
} from "./chat-interaction-publications.js";
import { projectSafeChatPublication } from "./chat-publication-projection.js";
import { publicChatTaskUrl } from "./chat-task-url.js";
import { notifyChatPublicationWork } from "./chat-work-notifications.js";
import {
  boundedStallAfterMs,
  classifyFounderNotification,
  founderNotificationDue,
  type FounderNotificationClass,
} from "./founder-notification-policy.js";

/**
 * Founder notification state is stored in the existing native chat action and
 * publication tables rather than a parallel notification database, so the
 * native fork carries no schema migration. Route and episode rows are
 * internal: their provider action ids are deterministic server keys (like the
 * existing `interaction_wakeup:` rows), never provider callbacks. Only the
 * opaque acknowledgement token is a real callback.
 *
 * None of these rows is read by dispatch, assignment, recovery, review, merge
 * or release paths. Notification state grants no task authority and never
 * changes task lifecycle.
 */
export const FOUNDER_NOTIFICATION_ROUTE_KIND = "founder_notification_route";
export const FOUNDER_NOTIFICATION_EPISODE_KIND = "founder_notification_episode";
export const FOUNDER_NOTIFICATION_ACK_KIND = "founder_notification_ack";
export const FOUNDER_NOTIFICATION_ACK_TTL_MS = 7 * 24 * 60 * 60_000;
const ACK_TOKEN_PREFIX = "pcf:";
const MAX_CARD_TEXT = 160;
const EPISODE_LIST_LIMIT = 100;

type RouteStatus = "enabled" | "disabled";
type EpisodeStatus = "observing" | "open" | "resolved";

export type FounderNotificationRoutePayload = {
  version: 1;
  recipientUserId: string;
  stallAfterMs: number;
  createdByUserId: string | null;
  updatedByUserId: string | null;
};

export type FounderNotificationEpisodePayload = {
  version: 1;
  routeId: string;
  recipientUserId: string;
  attentionItemId: string;
  sourceKind: string;
  notificationClass: FounderNotificationClass;
  dedupKey: string;
  occurrence: number;
  issueId: string;
  issueIdentifier: string | null;
  label: string;
  firstObservedAt: string;
  lastObservedAt: string;
  observations: number;
  notifiedAt: string | null;
  publicationId: string | null;
  /** Last delivery state already surfaced in logs; avoids per-tick noise. */
  reportedDeliveryState: string | null;
  acknowledgedAt: string | null;
  acknowledgedByUserId: string | null;
  acknowledgedVia: "chat" | "board" | null;
  resolvedAt: string | null;
  resolutionReason: "item_cleared" | "cleared_before_notification" | "route_disabled" | null;
  resolutionPublicationId: string | null;
};

export type FounderNotificationAckPayload = {
  version: 1;
  routeId: string;
  episodeId: string;
  publicationId: string;
  recipientUserId: string;
  expiresAt: string;
};

type ActionRow = typeof chatActions.$inferSelect;
export type FounderRouteRow = ActionRow & { payload: FounderNotificationRoutePayload };
export type FounderEpisodeRow = ActionRow & { payload: FounderNotificationEpisodePayload };

type FounderDb = Pick<Db, "select" | "selectDistinct" | "insert" | "update" | "transaction">;

export function founderRouteActionId(recipientUserId: string): string {
  return `founder-route:${recipientUserId}`;
}

/**
 * The dedup key is server-generated but unbounded; hash it so the durable
 * provider action id stays short while the original key remains in payload.
 */
export function founderEpisodeActionId(routeId: string, dedupKey: string, occurrence: number): string {
  const digest = createHash("sha256").update(dedupKey).digest("hex").slice(0, 40);
  return `founder-episode:${routeId}:${digest}:${occurrence}`;
}

/**
 * Outbox keys use their own prefix so no existing in-place edit, interaction
 * settlement or run-progress supersession path ever matches them.
 */
export function founderPublicationKey(episodeId: string): string {
  return `founder-notification:${episodeId}`;
}
export function founderResolutionPublicationKey(episodeId: string): string {
  return `founder-notification-resolution:${episodeId}`;
}
export function founderAckPublicationKey(episodeId: string): string {
  return `founder-notification-ack:${episodeId}`;
}

export function createFounderAckToken(): string {
  return `${ACK_TOKEN_PREFIX}${randomBytes(16).toString("base64url")}`;
}

function isFounderRouteRow(row: ActionRow): row is FounderRouteRow {
  const payload = row.payload as Partial<FounderNotificationRoutePayload>;
  return (
    row.kind === FOUNDER_NOTIFICATION_ROUTE_KIND &&
    payload?.version === 1 &&
    typeof payload.recipientUserId === "string" &&
    typeof row.conversationId === "string"
  );
}

function isFounderEpisodeRow(row: ActionRow): row is FounderEpisodeRow {
  const payload = row.payload as Partial<FounderNotificationEpisodePayload>;
  return row.kind === FOUNDER_NOTIFICATION_EPISODE_KIND && payload?.version === 1 && typeof payload.routeId === "string";
}

export function isFounderAckPayload(value: unknown): value is FounderNotificationAckPayload {
  const payload = value as Partial<FounderNotificationAckPayload> | null;
  return (
    !!payload &&
    payload.version === 1 &&
    typeof payload.routeId === "string" &&
    typeof payload.episodeId === "string" &&
    typeof payload.publicationId === "string" &&
    typeof payload.recipientUserId === "string" &&
    typeof payload.expiresAt === "string"
  );
}

// ---------------------------------------------------------------------------
// Route target and binding

export type FounderRouteBinding =
  | { verified: true }
  | { verified: false; reason: FounderNotificationRouteUnavailableReason };

type ConversationRow = typeof chatConversations.$inferSelect;
type EndpointRow = typeof chatEndpoints.$inferSelect;

export type FounderRouteTarget =
  | { binding: { verified: true }; endpoint: EndpointRow; conversation: ConversationRow }
  | { binding: { verified: false; reason: FounderNotificationRouteUnavailableReason } };

/** Mirrors dispatch: a delivered `/new` or `/close` retires that generation. */
export async function conversationClosedByTaskControl(
  db: Pick<Db, "select">,
  conversationId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: chatPublications.id })
    .from(chatPublications)
    .where(
      and(
        eq(chatPublications.conversationId, conversationId),
        eq(chatPublications.state, "published"),
        or(
          like(chatPublications.idempotencyKey, "control:new:%"),
          like(chatPublications.idempotencyKey, "control:close:%"),
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Resolves where a route can deliver now and proves, at use time, that it
 * still reaches exactly its recipient. The route anchors one direct-message
 * thread; the target is that thread's newest sendable generation, so a
 * founder's `/new` does not silently strand notifications on a retired row.
 *
 * Every human who ever wrote into that thread must be linked to the
 * recipient, at least one such message must exist, and the recipient must
 * still be an active company member. Any doubt fails closed.
 */
export async function resolveFounderRouteTarget(
  db: Pick<Db, "select" | "selectDistinct">,
  input: { companyId: string; endpointId: string; conversationId: string; recipientUserId: string },
): Promise<FounderRouteTarget> {
  const unavailable = (reason: FounderNotificationRouteUnavailableReason): FounderRouteTarget => ({
    binding: { verified: false, reason },
  });
  const endpoint = await db
    .select()
    .from(chatEndpoints)
    .where(and(eq(chatEndpoints.companyId, input.companyId), eq(chatEndpoints.id, input.endpointId)))
    .then((rows) => rows[0] ?? null);
  if (
    !endpoint ||
    endpoint.archivedAt ||
    (endpoint.status !== "active" && endpoint.status !== "verifying") ||
    endpoint.publicationMode !== "automatic" ||
    !endpoint.allowDirectMessages
  ) {
    return unavailable("endpoint_unavailable");
  }
  const anchor = await db
    .select()
    .from(chatConversations)
    .where(and(eq(chatConversations.companyId, input.companyId), eq(chatConversations.id, input.conversationId)))
    .then((rows) => rows[0] ?? null);
  if (!anchor || anchor.endpointId !== input.endpointId) return unavailable("conversation_unavailable");
  if (!anchor.isDirectMessage) return unavailable("not_direct_message");

  const generations = await db
    .select()
    .from(chatConversations)
    .where(
      and(
        eq(chatConversations.companyId, input.companyId),
        eq(chatConversations.endpointId, input.endpointId),
        eq(chatConversations.externalConversationId, anchor.externalConversationId),
        eq(chatConversations.externalThreadId, anchor.externalThreadId),
      ),
    )
    .orderBy(desc(chatConversations.sessionGeneration));
  if (generations.some((row) => !row.isDirectMessage)) return unavailable("not_direct_message");

  const participants = await db
    .selectDistinct({
      principalId: chatExternalPrincipals.id,
      kind: chatExternalPrincipals.kind,
      isBot: chatExternalPrincipals.isBot,
      linkStatus: chatIdentityLinks.status,
      linkedUserId: chatIdentityLinks.paperclipUserId,
    })
    .from(chatDeliveries)
    .innerJoin(
      chatExternalPrincipals,
      and(
        eq(chatExternalPrincipals.companyId, chatDeliveries.companyId),
        eq(chatExternalPrincipals.id, chatDeliveries.principalId),
      ),
    )
    .leftJoin(
      chatIdentityLinks,
      and(
        eq(chatIdentityLinks.companyId, chatDeliveries.companyId),
        eq(chatIdentityLinks.endpointId, chatDeliveries.endpointId),
        eq(chatIdentityLinks.principalId, chatExternalPrincipals.id),
      ),
    )
    .where(
      and(
        eq(chatDeliveries.companyId, input.companyId),
        eq(chatDeliveries.endpointId, input.endpointId),
        inArray(
          chatDeliveries.conversationId,
          generations.map((row) => row.id),
        ),
        isNotNull(chatDeliveries.principalId),
      ),
    );
  const humans = participants.filter((row) => row.kind !== "bot" && !row.isBot);
  if (humans.some((row) => row.linkStatus !== "linked" || row.linkedUserId !== input.recipientUserId)) {
    return unavailable("foreign_participant");
  }
  if (humans.length === 0) return unavailable("recipient_not_linked");

  const membership = await db
    .select({ id: companyMemberships.id, role: companyMemberships.membershipRole })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, input.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, input.recipientUserId),
        eq(companyMemberships.status, "active"),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!membership) return unavailable("recipient_not_member");

  for (const conversation of generations) {
    if (conversation.state === "unavailable" || conversation.state === "endpoint_removed") continue;
    if (conversation.state === "completed" && (await conversationClosedByTaskControl(db, conversation.id))) continue;
    return { binding: { verified: true }, endpoint, conversation };
  }
  return unavailable("conversation_unavailable");
}

// ---------------------------------------------------------------------------
// Pure message projection

const SOURCE_LABELS: Record<string, string> = {
  approval: "Approval needed",
  decision: "Decision needed",
  review: "Review verdict needed",
  recovery_action: "Recovery needs you",
};

/** Closed server labels; the card never echoes model rationale or whyNow. */
export function founderNotificationLabel(item: AttentionItem, kind: FounderNotificationClass): string {
  if (item.sourceKind === "issue_thread_interaction") {
    return item.subject.metadata?.kind === "ask_user_questions" ? "Question needs your answer" : "Decision needs you";
  }
  if (item.sourceKind === "blocker_attention") {
    return kind === "decision" ? "Blocked on you" : "Stalled: blocked work needs attention";
  }
  if (item.sourceKind === "failed_run") return "Stalled: latest run failed";
  return SOURCE_LABELS[item.sourceKind] ?? "Needs your attention";
}

function clip(value: string | null | undefined): string | null {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const points = [...text];
  return points.length > MAX_CARD_TEXT ? `${points.slice(0, MAX_CARD_TEXT - 1).join("")}…` : text;
}

function taskSubject(item: AttentionItem) {
  const subject = item.relatedIssue?.kind === "issue" ? item.relatedIssue : item.subject.kind === "issue" ? item.subject : null;
  return { identifier: subject?.identifier ?? null, title: subject?.title ?? null };
}

export function buildFounderNotificationMessage(input: {
  item: AttentionItem;
  kind: FounderNotificationClass;
  label: string;
  taskUrl: string | null;
  stallAfterMs: number;
}): { title: string; body: string; text: string } {
  const task = taskSubject(input.item);
  const name = task.identifier ?? "A task";
  const title = `${name}: ${input.label}`;
  const decisionTitle = input.item.subject.kind === "issue" ? null : clip(input.item.subject.title);
  const lines = [clip(task.title), decisionTitle && decisionTitle !== clip(task.title) ? decisionTitle : null].filter(
    (line): line is string => Boolean(line),
  );
  if (input.kind === "stall") {
    lines.push(
      `It has not recovered automatically for at least ${Math.round(boundedStallAfterMs(input.stallAfterMs) / 60_000)} minutes.`,
    );
  } else {
    lines.push("This task is waiting on you. Answer it in Paperclip to let the same task continue.");
  }
  lines.push(`Messages typed in this chat are not delivered to ${name}.`);
  const body = lines.join("\n");
  const text = [title, body, input.taskUrl ? `Open in Paperclip: ${input.taskUrl}` : "Open the task in Paperclip."].join(
    "\n\n",
  );
  return { title, body, text };
}

// ---------------------------------------------------------------------------
// Route management (board connection managers only; enforced by the route)

/** chat_actions is indexed by endpoint; scope company reads through it. */
async function companyEndpointIds(db: Pick<Db, "select">, companyId: string): Promise<string[]> {
  return (
    await db.select({ id: chatEndpoints.id }).from(chatEndpoints).where(eq(chatEndpoints.companyId, companyId))
  ).map((row) => row.id);
}

async function readRoute(db: Pick<Db, "select">, companyId: string, routeId: string): Promise<FounderRouteRow> {
  const row = await db
    .select()
    .from(chatActions)
    .where(
      and(
        eq(chatActions.companyId, companyId),
        eq(chatActions.id, routeId),
        eq(chatActions.kind, FOUNDER_NOTIFICATION_ROUTE_KIND),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!row || !isFounderRouteRow(row)) throw notFound("Founder notification route not found");
  return row;
}

export async function listFounderRoutes(
  db: Pick<Db, "select">,
  companyId: string,
  options: { enabledOnly?: boolean } = {},
): Promise<FounderRouteRow[]> {
  const endpointIds = await companyEndpointIds(db, companyId);
  if (endpointIds.length === 0) return [];
  const rows = await db
    .select()
    .from(chatActions)
    .where(
      and(
        eq(chatActions.companyId, companyId),
        inArray(chatActions.endpointId, endpointIds),
        eq(chatActions.kind, FOUNDER_NOTIFICATION_ROUTE_KIND),
        ...(options.enabledOnly ? [eq(chatActions.status, "enabled")] : []),
      ),
    )
    .orderBy(desc(chatActions.createdAt));
  return rows.filter(isFounderRouteRow);
}

function routeUnavailableReason(row: FounderRouteRow): FounderNotificationRouteUnavailableReason | null {
  const reason = (row.result as { unavailableReason?: unknown } | null)?.unavailableReason;
  return typeof reason === "string" ? (reason as FounderNotificationRouteUnavailableReason) : null;
}

function routeView(row: FounderRouteRow, binding: FounderRouteBinding): FounderNotificationRoute {
  return {
    id: row.id,
    companyId: row.companyId,
    recipientUserId: row.payload.recipientUserId,
    endpointId: row.endpointId,
    conversationId: row.conversationId!,
    enabled: row.status === "enabled",
    stallAfterMs: boundedStallAfterMs(row.payload.stallAfterMs),
    lastUnavailableReason: routeUnavailableReason(row),
    binding,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function routeWithBinding(db: Pick<Db, "select" | "selectDistinct">, row: FounderRouteRow) {
  const target = await resolveFounderRouteTarget(db, {
    companyId: row.companyId,
    endpointId: row.endpointId,
    conversationId: row.conversationId!,
    recipientUserId: row.payload.recipientUserId,
  });
  return routeView(row, target.binding);
}

/**
 * Creates or replaces the single route for one recipient. A route may only
 * be enabled when its binding verifies now; the reconciler re-verifies before
 * every publication regardless.
 */
export async function upsertFounderRoute(
  db: FounderDb,
  companyId: string,
  input: { recipientUserId: string; endpointId: string; conversationId: string; enabled: boolean; stallAfterMs?: number },
  actorUserId: string | null,
): Promise<FounderNotificationRoute> {
  const target = await resolveFounderRouteTarget(db, { companyId, ...input });
  if (input.enabled && !target.binding.verified) {
    throw unprocessable("Founder notification route cannot be enabled", { reason: target.binding.reason });
  }
  const row = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`founder-notification-route:${companyId}:${input.recipientUserId}`}, 0))`,
    );
    const existing = await tx
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.companyId, companyId),
          inArray(chatActions.endpointId, await companyEndpointIds(tx, companyId)),
          eq(chatActions.kind, FOUNDER_NOTIFICATION_ROUTE_KIND),
          eq(chatActions.providerActionId, founderRouteActionId(input.recipientUserId)),
        ),
      )
      .then((rows) => rows.filter(isFounderRouteRow));
    if (existing.some((route) => route.endpointId !== input.endpointId)) {
      throw conflict("This recipient already has a founder notification route on another endpoint");
    }
    const current = existing[0] ?? null;
    const payload: FounderNotificationRoutePayload = {
      version: 1,
      recipientUserId: input.recipientUserId,
      stallAfterMs: boundedStallAfterMs(input.stallAfterMs ?? current?.payload.stallAfterMs),
      createdByUserId: current?.payload.createdByUserId ?? actorUserId,
      updatedByUserId: actorUserId,
    };
    const status: RouteStatus = input.enabled ? "enabled" : "disabled";
    if (current) {
      const [updated] = await tx
        .update(chatActions)
        .set({ conversationId: input.conversationId, payload, status, updatedAt: new Date() })
        .where(eq(chatActions.id, current.id))
        .returning();
      if (!input.enabled && current.status === "enabled") await quiesceFounderRoute(tx, current);
      return updated!;
    }
    const [inserted] = await tx
      .insert(chatActions)
      .values({
        companyId,
        endpointId: input.endpointId,
        conversationId: input.conversationId,
        kind: FOUNDER_NOTIFICATION_ROUTE_KIND,
        providerActionId: founderRouteActionId(input.recipientUserId),
        payload,
        status,
      })
      .returning();
    return inserted!;
  });
  return routeView(row as FounderRouteRow, target.binding);
}

export async function updateFounderRoute(
  db: FounderDb,
  companyId: string,
  routeId: string,
  input: { enabled?: boolean; stallAfterMs?: number },
  actorUserId: string | null,
): Promise<FounderNotificationRoute> {
  const route = await readRoute(db, companyId, routeId);
  return upsertFounderRoute(
    db,
    companyId,
    {
      recipientUserId: route.payload.recipientUserId,
      endpointId: route.endpointId,
      conversationId: route.conversationId!,
      enabled: input.enabled ?? route.status === "enabled",
      stallAfterMs: input.stallAfterMs ?? route.payload.stallAfterMs,
    },
    actorUserId,
  );
}

/**
 * Disabling is the kill switch: anything not yet handed to a provider stops,
 * outstanding buttons expire, and active episodes close silently. Re-enabling
 * therefore starts clean: every fact still present opens a fresh occurrence
 * and is sent, instead of being stranded behind a cancelled card.
 */
async function quiesceFounderRoute(db: Pick<Db, "select" | "update">, route: FounderRouteRow) {
  const now = new Date();
  const active = await routeEpisodes(db, route, ["observing", "open"]);
  for (const episode of active) {
    await db
      .update(chatActions)
      .set({
        status: "resolved",
        payload: { ...episode.payload, resolvedAt: now.toISOString(), resolutionReason: "route_disabled" },
        updatedAt: now,
      })
      .where(and(eq(chatActions.id, episode.id), inArray(chatActions.status, ["observing", "open"])));
  }
  await db
    .update(chatActions)
    .set({ status: "expired", result: { code: "founder_notification_route_disabled" }, updatedAt: now })
    .where(
      and(
        eq(chatActions.companyId, route.companyId),
        eq(chatActions.endpointId, route.endpointId),
        eq(chatActions.kind, FOUNDER_NOTIFICATION_ACK_KIND),
        eq(chatActions.status, "issued"),
        sql`${chatActions.payload}->>'routeId' = ${route.id}`,
      ),
    );
  const episodes = await routeEpisodes(db, route, ["resolved"]);
  const keys = episodes.flatMap((episode) => [
    founderPublicationKey(episode.id),
    founderResolutionPublicationKey(episode.id),
    founderAckPublicationKey(episode.id),
  ]);
  if (keys.length === 0) return;
  await db
    .update(chatPublications)
    .set({
      state: "cancelled",
      nextAttemptAt: null,
      redactedError: "Founder notification route was disabled before provider publication",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(chatPublications.companyId, route.companyId),
        inArray(chatPublications.idempotencyKey, keys),
        inArray(chatPublications.state, ["pending", "retry"]),
      ),
    );
}

export async function listFounderRouteViews(db: Pick<Db, "select" | "selectDistinct">, companyId: string) {
  const rows = await listFounderRoutes(db, companyId);
  return Promise.all(rows.map((row) => routeWithBinding(db, row)));
}

// ---------------------------------------------------------------------------
// Episodes

async function routeEpisodes(
  db: Pick<Db, "select">,
  route: Pick<FounderRouteRow, "id" | "companyId" | "endpointId">,
  statuses: EpisodeStatus[],
): Promise<FounderEpisodeRow[]> {
  const rows = await db
    .select()
    .from(chatActions)
    .where(
      and(
        eq(chatActions.companyId, route.companyId),
        eq(chatActions.endpointId, route.endpointId),
        eq(chatActions.kind, FOUNDER_NOTIFICATION_EPISODE_KIND),
        inArray(chatActions.status, statuses),
        sql`${chatActions.payload}->>'routeId' = ${route.id}`,
      ),
    )
    .orderBy(desc(chatActions.createdAt));
  return rows.filter(isFounderEpisodeRow);
}

function deliveryState(publication: typeof chatPublications.$inferSelect | undefined): FounderNotificationDeliveryState {
  return publication?.state ?? "not_sent";
}

export async function listFounderEpisodeViews(
  db: Pick<Db, "select">,
  companyId: string,
): Promise<FounderNotificationEpisode[]> {
  const endpointIds = [...new Set((await listFounderRoutes(db, companyId)).map((route) => route.endpointId))];
  if (endpointIds.length === 0) return [];
  const rows = (
    await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.companyId, companyId),
          inArray(chatActions.endpointId, endpointIds),
          eq(chatActions.kind, FOUNDER_NOTIFICATION_EPISODE_KIND),
        ),
      )
      .orderBy(desc(chatActions.updatedAt))
      .limit(EPISODE_LIST_LIMIT)
  ).filter(isFounderEpisodeRow);
  const publicationIds = rows.flatMap((row) =>
    [row.payload.publicationId, row.payload.resolutionPublicationId].filter((id): id is string => Boolean(id)),
  );
  const publications = publicationIds.length
    ? await db
        .select()
        .from(chatPublications)
        .where(and(eq(chatPublications.companyId, companyId), inArray(chatPublications.id, publicationIds)))
    : [];
  const byId = new Map(publications.map((row) => [row.id, row]));
  return rows.map((row) => {
    const publication = row.payload.publicationId ? byId.get(row.payload.publicationId) : undefined;
    const resolution = row.payload.resolutionPublicationId ? byId.get(row.payload.resolutionPublicationId) : undefined;
    return {
      id: row.id,
      routeId: row.payload.routeId,
      recipientUserId: row.payload.recipientUserId,
      attentionItemId: row.payload.attentionItemId,
      sourceKind: row.payload.sourceKind,
      notificationClass: row.payload.notificationClass,
      occurrence: row.payload.occurrence,
      issueId: row.payload.issueId,
      issueIdentifier: row.payload.issueIdentifier,
      state: row.status as EpisodeStatus,
      firstObservedAt: row.payload.firstObservedAt,
      lastObservedAt: row.payload.lastObservedAt,
      observations: row.payload.observations,
      notifiedAt: row.payload.notifiedAt,
      acknowledgedAt: row.payload.acknowledgedAt,
      resolvedAt: row.payload.resolvedAt,
      delivery: {
        state: deliveryState(publication),
        attempts: publication?.attempts ?? 0,
        redactedError: publication?.redactedError ?? null,
        publishedAt: publication?.publishedAt?.toISOString() ?? null,
      },
      resolutionDelivery: row.payload.resolutionPublicationId ? { state: deliveryState(resolution) } : null,
    };
  });
}

async function nextOccurrences(
  db: Pick<Db, "select">,
  route: FounderRouteRow,
  dedupKeys: string[],
): Promise<Map<string, number>> {
  if (dedupKeys.length === 0) return new Map();
  const rows = await db
    .select({
      dedupKey: sql<string>`${chatActions.payload}->>'dedupKey'`,
      occurrence: sql<number>`max((${chatActions.payload}->>'occurrence')::int)`,
    })
    .from(chatActions)
    .where(
      and(
        eq(chatActions.companyId, route.companyId),
        eq(chatActions.endpointId, route.endpointId),
        eq(chatActions.kind, FOUNDER_NOTIFICATION_EPISODE_KIND),
        sql`${chatActions.payload}->>'routeId' = ${route.id}`,
        inArray(sql<string>`${chatActions.payload}->>'dedupKey'`, dedupKeys),
      ),
    )
    .groupBy(sql`${chatActions.payload}->>'dedupKey'`);
  return new Map(rows.map((row) => [row.dedupKey, Number(row.occurrence) + 1]));
}

export type FounderReconcileResult = {
  observed: number;
  opened: number;
  resolved: number;
  resolutionNotices: number;
  routeUnavailable: FounderNotificationRouteUnavailableReason | null;
};

/**
 * One reconciliation pass for one route over one complete attention snapshot.
 * Idempotent: repeated passes, overlapping passes and restarts converge on
 * the same episode rows and publication idempotency keys. A failed snapshot
 * must never reach this function, because absence here means resolution.
 */
export async function reconcileFounderRoute(
  db: FounderDb,
  route: FounderRouteRow,
  items: AttentionItem[],
  now: Date,
): Promise<FounderReconcileResult> {
  const result: FounderReconcileResult = { observed: 0, opened: 0, resolved: 0, resolutionNotices: 0, routeUnavailable: null };
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const stallAfterMs = boundedStallAfterMs(route.payload.stallAfterMs);

  const present = new Map<string, AttentionItem>();
  const actionable = new Map<string, { item: AttentionItem; kind: FounderNotificationClass; taskIssueId: string }>();
  for (const item of items) {
    present.set(item.dedupKey, item);
    const classification = classifyFounderNotification(item, nowMs);
    if (classification.notify) {
      actionable.set(item.dedupKey, { item, kind: classification.kind, taskIssueId: classification.taskIssueId });
    }
  }

  const active = await routeEpisodes(db, route, ["observing", "open"]);
  const activeByKey = new Map(active.map((episode) => [episode.payload.dedupKey, episode]));

  // Resolution: an episode whose fact left the complete snapshot. Facts that
  // remain present but are now quiet (snoozed/dismissed) are not resolved.
  for (const episode of active) {
    if (present.has(episode.payload.dedupKey)) continue;
    const resolved = await resolveEpisode(db, route, episode, nowIso);
    if (resolved.resolved) result.resolved += 1;
    if (resolved.notice) result.resolutionNotices += 1;
  }

  const missing = [...actionable.keys()].filter((key) => !activeByKey.has(key));
  const occurrences = await nextOccurrences(db, route, missing);
  for (const [dedupKey, fact] of actionable) {
    result.observed += 1;
    let episode = activeByKey.get(dedupKey) ?? null;
    if (!episode) {
      const occurrence = occurrences.get(dedupKey) ?? 1;
      const payload: FounderNotificationEpisodePayload = {
        version: 1,
        routeId: route.id,
        recipientUserId: route.payload.recipientUserId,
        attentionItemId: fact.item.id,
        sourceKind: fact.item.sourceKind,
        notificationClass: fact.kind,
        dedupKey,
        occurrence,
        issueId: fact.taskIssueId,
        issueIdentifier: taskSubject(fact.item).identifier,
        label: founderNotificationLabel(fact.item, fact.kind),
        firstObservedAt: nowIso,
        lastObservedAt: nowIso,
        observations: 1,
        notifiedAt: null,
        publicationId: null,
        reportedDeliveryState: null,
        acknowledgedAt: null,
        acknowledgedByUserId: null,
        acknowledgedVia: null,
        resolvedAt: null,
        resolutionReason: null,
        resolutionPublicationId: null,
      };
      const inserted = await db
        .insert(chatActions)
        .values({
          companyId: route.companyId,
          endpointId: route.endpointId,
          conversationId: null,
          kind: FOUNDER_NOTIFICATION_EPISODE_KIND,
          providerActionId: founderEpisodeActionId(route.id, dedupKey, occurrence),
          payload,
          status: "observing",
        })
        .onConflictDoNothing()
        .returning();
      episode = (inserted[0] as FounderEpisodeRow | undefined) ?? null;
      if (!episode) continue; // A concurrent pass created it; the next pass continues.
    } else if (episode.status === "observing") {
      const observations = episode.payload.observations + 1;
      const [updated] = await db
        .update(chatActions)
        .set({
          payload: { ...episode.payload, observations, lastObservedAt: nowIso },
          updatedAt: now,
        })
        .where(and(eq(chatActions.id, episode.id), eq(chatActions.status, "observing")))
        .returning();
      if (!updated) continue;
      episode = updated as FounderEpisodeRow;
    }

    if (episode.status === "observing") {
      const due = founderNotificationDue({
        kind: fact.kind,
        firstObservedAt: Date.parse(episode.payload.firstObservedAt),
        observations: episode.payload.observations,
        now: nowMs,
        stallAfterMs,
      });
      if (!due) continue;
      const opened = await openEpisode(db, route, episode, fact.item, fact.kind, now);
      if (opened === "opened") result.opened += 1;
      else if (opened) result.routeUnavailable = opened;
    } else {
      await reportDeliveryState(db, episode);
    }
  }
  return result;
}

async function openEpisode(
  db: FounderDb,
  route: FounderRouteRow,
  episode: FounderEpisodeRow,
  item: AttentionItem,
  kind: FounderNotificationClass,
  now: Date,
): Promise<"opened" | FounderNotificationRouteUnavailableReason | null> {
  const target = await resolveFounderRouteTarget(db, {
    companyId: route.companyId,
    endpointId: route.endpointId,
    conversationId: route.conversationId!,
    recipientUserId: route.payload.recipientUserId,
  });
  // Unavailable routes keep observing: the episode stays due and is sent once
  // the binding is repaired, without consuming any provider retry budget.
  if (!target.binding.verified) return target.binding.reason;
  const { endpoint, conversation } = target as Extract<FounderRouteTarget, { endpoint: EndpointRow }>;
  const taskUrl = publicChatTaskUrl(episode.payload.issueId);
  const message = buildFounderNotificationMessage({
    item,
    kind,
    label: episode.payload.label,
    taskUrl,
    stallAfterMs: route.payload.stallAfterMs,
  });
  // Providers without native callbacks get the link only; the founder can
  // still acknowledge from Paperclip.
  const ackToken = endpoint.capabilities.actions === true ? createFounderAckToken() : null;
  if (
    ackToken &&
    endpoint.provider === "telegram" &&
    telegramCallbackDataByteLength(ackToken) > TELEGRAM_CALLBACK_DATA_LIMIT_BYTES
  ) {
    throw new Error("Generated Telegram founder acknowledgement exceeds 64 bytes");
  }
  const actions: SafeExternalChatCardAction[] = [
    ...(taskUrl ? [{ type: "link" as const, label: "Open in Paperclip", url: taskUrl }] : []),
    ...(ackToken ? [{ type: "callback" as const, actionId: ackToken, label: "Acknowledge" }] : []),
  ];
  const payload = projectSafeChatPublication({
    classification: "external",
    source: "founder_notification",
    text: message.text,
    // The card id is the episode UUID: it can never match a real interaction,
    // and uuid-typed interaction lookups stay well formed.
    interaction: { id: episode.id, card: { kind: "status", title: message.title, body: message.body, actions } },
  });
  return db.transaction(async (tx) => {
    const current = await tx
      .select()
      .from(chatActions)
      .where(eq(chatActions.id, episode.id))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!current || current.status !== "observing") return null;
    await notifyChatPublicationWork(tx);
    const [publication] = await tx
      .insert(chatPublications)
      .values({
        companyId: route.companyId,
        endpointId: route.endpointId,
        conversationId: conversation.id,
        issueId: episode.payload.issueId,
        idempotencyKey: founderPublicationKey(episode.id),
        payload,
        state: "pending",
      })
      .onConflictDoNothing()
      .returning();
    const publicationId =
      publication?.id ??
      (await tx
        .select({ id: chatPublications.id })
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.companyId, route.companyId),
            eq(chatPublications.idempotencyKey, founderPublicationKey(episode.id)),
          ),
        )
        .then((rows) => rows[0]?.id ?? null));
    if (!publicationId) return null;
    if (publication && ackToken) {
      const ackPayload: FounderNotificationAckPayload = {
        version: 1,
        routeId: route.id,
        episodeId: episode.id,
        publicationId,
        recipientUserId: route.payload.recipientUserId,
        expiresAt: new Date(now.getTime() + FOUNDER_NOTIFICATION_ACK_TTL_MS).toISOString(),
      };
      await tx.insert(chatActions).values({
        companyId: route.companyId,
        endpointId: route.endpointId,
        conversationId: conversation.id,
        kind: FOUNDER_NOTIFICATION_ACK_KIND,
        providerActionId: ackToken,
        payload: ackPayload,
        status: "issued",
      });
    }
    await tx
      .update(chatActions)
      .set({
        status: "open",
        conversationId: conversation.id,
        payload: { ...(current.payload as FounderNotificationEpisodePayload), notifiedAt: now.toISOString(), publicationId },
        updatedAt: now,
      })
      .where(and(eq(chatActions.id, episode.id), eq(chatActions.status, "observing")));
    return "opened" as const;
  });
}

/**
 * Settles an episode whose fact cleared. A never-sent card is cancelled; a
 * possibly provider-visible one (streaming, unknown or published) gets one
 * resolution notice so the phone never shows a stale actionable prompt.
 */
async function resolveEpisode(
  db: FounderDb,
  route: FounderRouteRow,
  episode: FounderEpisodeRow,
  nowIso: string,
): Promise<{ resolved: boolean; notice: boolean }> {
  return db.transaction(async (tx) => {
    const current = await tx
      .select()
      .from(chatActions)
      .where(eq(chatActions.id, episode.id))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!current || (current.status !== "observing" && current.status !== "open")) {
      return { resolved: false, notice: false };
    }
    const payload = current.payload as FounderNotificationEpisodePayload;
    if (current.status === "observing") {
      await tx
        .update(chatActions)
        .set({
          status: "resolved",
          payload: { ...payload, resolvedAt: nowIso, resolutionReason: "cleared_before_notification" },
          updatedAt: new Date(nowIso),
        })
        .where(eq(chatActions.id, episode.id));
      return { resolved: true, notice: false };
    }

    await tx
      .update(chatActions)
      .set({ status: "expired", result: { code: "founder_notification_resolved" }, updatedAt: new Date(nowIso) })
      .where(
        and(
          eq(chatActions.companyId, route.companyId),
          eq(chatActions.endpointId, route.endpointId),
          eq(chatActions.kind, FOUNDER_NOTIFICATION_ACK_KIND),
          eq(chatActions.status, "issued"),
          sql`${chatActions.payload}->>'episodeId' = ${episode.id}`,
        ),
      );
    await notifyChatPublicationWork(tx);
    await tx
      .update(chatPublications)
      .set({
        state: "cancelled",
        nextAttemptAt: null,
        redactedError: "Founder notification resolved before provider publication",
        updatedAt: new Date(nowIso),
      })
      .where(
        and(
          eq(chatPublications.companyId, route.companyId),
          eq(chatPublications.idempotencyKey, founderPublicationKey(episode.id)),
          inArray(chatPublications.state, ["pending", "retry"]),
        ),
      );
    // Re-read after the cancellation CAS: a dispatcher that claimed the row
    // first may already have handed it to the provider.
    const original = await tx
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.companyId, route.companyId),
          eq(chatPublications.idempotencyKey, founderPublicationKey(episode.id)),
        ),
      )
      .then((rows) => rows[0] ?? null);
    let resolutionPublicationId: string | null = null;
    if (original && ["streaming", "published", "delivery_unknown"].includes(original.state)) {
      const name = payload.issueIdentifier ?? "The task";
      const [notice] = await tx
        .insert(chatPublications)
        .values({
          companyId: route.companyId,
          endpointId: original.endpointId,
          conversationId: original.conversationId,
          issueId: payload.issueId,
          idempotencyKey: founderResolutionPublicationKey(episode.id),
          payload: projectSafeChatPublication({
            classification: "external",
            source: "founder_notification",
            text: `Resolved: ${name} no longer needs you (${payload.label}).`,
          }),
          state: "pending",
        })
        .onConflictDoNothing()
        .returning();
      resolutionPublicationId = notice?.id ?? null;
    }
    await tx
      .update(chatActions)
      .set({
        status: "resolved",
        payload: { ...payload, resolvedAt: nowIso, resolutionReason: "item_cleared", resolutionPublicationId },
        updatedAt: new Date(nowIso),
      })
      .where(eq(chatActions.id, episode.id));
    return { resolved: true, notice: resolutionPublicationId !== null };
  });
}

const VISIBLE_FAILURE_STATES = new Set(["failed", "cancelled", "delivery_unknown"]);

/** Transport failures stay visible: log each new failure state exactly once. */
async function reportDeliveryState(db: Pick<Db, "select" | "update">, episode: FounderEpisodeRow) {
  if (!episode.payload.publicationId) return;
  const publication = await db
    .select({ state: chatPublications.state, attempts: chatPublications.attempts, redactedError: chatPublications.redactedError })
    .from(chatPublications)
    .where(eq(chatPublications.id, episode.payload.publicationId))
    .then((rows) => rows[0] ?? null);
  const state: string = publication?.state ?? "missing";
  if (state === episode.payload.reportedDeliveryState) return;
  if (VISIBLE_FAILURE_STATES.has(state) || state === "missing") {
    logger.warn(
      {
        episodeId: episode.id,
        issueId: episode.payload.issueId,
        deliveryState: state,
        attempts: publication?.attempts ?? 0,
        redactedError: publication?.redactedError ?? null,
      },
      "founder notification delivery needs attention",
    );
  }
  await db
    .update(chatActions)
    .set({ payload: { ...episode.payload, reportedDeliveryState: state } })
    .where(eq(chatActions.id, episode.id));
}

// ---------------------------------------------------------------------------
// Acknowledgement

/**
 * Records that the founder saw an open episode. It never resolves the
 * underlying decision or changes the task: the task keeps waiting until the
 * founder answers in Paperclip, whose resolution resumes the same task.
 */
export async function acknowledgeFounderEpisode(
  tx: Pick<Db, "select" | "insert" | "update">,
  input: { companyId: string; episodeId: string; userId: string; via: "chat" | "board"; now?: Date },
): Promise<{ acknowledged: boolean; episode: FounderEpisodeRow }> {
  const now = input.now ?? new Date();
  const row = await tx
    .select()
    .from(chatActions)
    .where(
      and(
        eq(chatActions.companyId, input.companyId),
        eq(chatActions.id, input.episodeId),
        eq(chatActions.kind, FOUNDER_NOTIFICATION_EPISODE_KIND),
      ),
    )
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!row || !isFounderEpisodeRow(row)) throw notFound("Founder notification not found");
  if (row.payload.recipientUserId !== input.userId) throw forbidden("Only the notified recipient can acknowledge");
  if (row.status !== "open") throw conflict("Founder notification is not open");
  if (row.payload.acknowledgedAt) return { acknowledged: false, episode: row };
  const payload: FounderNotificationEpisodePayload = {
    ...row.payload,
    acknowledgedAt: now.toISOString(),
    acknowledgedByUserId: input.userId,
    acknowledgedVia: input.via,
  };
  const [updated] = await tx
    .update(chatActions)
    .set({ payload, updatedAt: now })
    .where(eq(chatActions.id, row.id))
    .returning();
  await tx
    .update(chatActions)
    .set({ status: "processed", result: { code: "founder_notification_acknowledged", via: input.via }, updatedAt: now })
    .where(
      and(
        eq(chatActions.companyId, input.companyId),
        eq(chatActions.endpointId, row.endpointId),
        eq(chatActions.kind, FOUNDER_NOTIFICATION_ACK_KIND),
        eq(chatActions.status, "issued"),
        sql`${chatActions.payload}->>'episodeId' = ${row.id}`,
      ),
    );
  const original = row.payload.publicationId
    ? await tx
        .select()
        .from(chatPublications)
        .where(eq(chatPublications.id, row.payload.publicationId))
        .then((rows) => rows[0] ?? null)
    : null;
  if (original && ["streaming", "published", "delivery_unknown"].includes(original.state)) {
    const name = row.payload.issueIdentifier ?? "The task";
    await notifyChatPublicationWork(tx);
    await tx
      .insert(chatPublications)
      .values({
        companyId: input.companyId,
        endpointId: original.endpointId,
        conversationId: original.conversationId,
        issueId: row.payload.issueId,
        idempotencyKey: founderAckPublicationKey(row.id),
        payload: projectSafeChatPublication({
          classification: "external",
          source: "founder_notification",
          text:
            row.payload.notificationClass === "decision"
              ? `Acknowledged: ${name} stays waiting until it is answered in Paperclip.`
              : `Acknowledged: you will get a notice when ${name} recovers.`,
        }),
        state: "pending",
      })
      .onConflictDoNothing();
  }
  return { acknowledged: true, episode: updated as FounderEpisodeRow };
}

// ---------------------------------------------------------------------------
// Sweep

export type FounderNotificationSweepDeps = {
  /** Complete, recipient-scoped attention snapshot. Must throw on failure. */
  listAttention: (companyId: string, recipientUserId: string, actor: AuthorizationActor) => Promise<AttentionItem[]>;
  now?: () => Date;
};

async function recipientActor(
  db: Pick<Db, "select">,
  companyId: string,
  userId: string,
): Promise<AuthorizationActor | null> {
  const membership = await db
    .select({
      companyId: companyMemberships.companyId,
      membershipRole: companyMemberships.membershipRole,
      status: companyMemberships.status,
    })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId),
        eq(companyMemberships.status, "active"),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!membership) return null;
  return { type: "board", userId, companyIds: [companyId], memberships: [membership], source: "session" };
}

export function founderNotificationService(db: Db, deps: FounderNotificationSweepDeps) {
  let running: Promise<FounderReconcileResult[]> | null = null;

  async function sweepOnce(): Promise<FounderReconcileResult[]> {
    // chat_actions is indexed by endpoint, not kind. Live endpoints are a
    // small table, so scope the lookup through them instead of scanning.
    const endpointIds = (
      await db
        .select({ id: chatEndpoints.id })
        .from(chatEndpoints)
        .where(inArray(chatEndpoints.status, ["active", "verifying"]))
    ).map((row) => row.id);
    if (endpointIds.length === 0) return [];
    const routes = (
      await db
        .select()
        .from(chatActions)
        .where(
          and(
            inArray(chatActions.endpointId, endpointIds),
            eq(chatActions.kind, FOUNDER_NOTIFICATION_ROUTE_KIND),
            eq(chatActions.status, "enabled"),
          ),
        )
    ).filter(isFounderRouteRow);
    const results: FounderReconcileResult[] = [];
    for (const route of routes) {
      try {
        const actor = await recipientActor(db, route.companyId, route.payload.recipientUserId);
        // Without a current member actor the snapshot is not trustworthy;
        // never treat that as every fact having cleared.
        if (!actor) continue;
        const items = await deps.listAttention(route.companyId, route.payload.recipientUserId, actor);
        const result = await reconcileFounderRoute(db, route, items, deps.now?.() ?? new Date());
        await recordRouteAvailability(route, result);
        results.push(result);
      } catch (err) {
        logger.warn({ err, routeId: route.id, companyId: route.companyId }, "founder notification sweep failed for route");
      }
    }
    return results;
  }

  /**
   * A due notification that cannot be sent is a delivery failure the board
   * must see. Persist and log only transitions so a long outage is one line.
   * The reason clears once a due episode is sent again.
   */
  async function recordRouteAvailability(route: FounderRouteRow, result: FounderReconcileResult) {
    const previous = routeUnavailableReason(route);
    const next = result.routeUnavailable ?? (result.opened > 0 ? null : previous);
    if (next === previous) return;
    await db
      .update(chatActions)
      .set({ result: next ? { unavailableReason: next } : null, updatedAt: new Date() })
      .where(and(eq(chatActions.id, route.id), eq(chatActions.kind, FOUNDER_NOTIFICATION_ROUTE_KIND)));
    if (next) {
      logger.warn({ routeId: route.id, companyId: route.companyId, reason: next }, "founder notification route cannot deliver");
    } else {
      logger.info({ routeId: route.id, companyId: route.companyId }, "founder notification route delivering again");
    }
  }

  return {
    /** Overlapping scheduler ticks share one in-flight pass. */
    sweep(): Promise<FounderReconcileResult[]> {
      if (!running) running = sweepOnce().finally(() => (running = null));
      return running;
    },
    acknowledge: (companyId: string, episodeId: string, userId: string) =>
      db.transaction((tx) => acknowledgeFounderEpisode(tx, { companyId, episodeId, userId, via: "board" })),
    listRoutes: (companyId: string) => listFounderRouteViews(db, companyId),
    listEpisodes: (companyId: string) => listFounderEpisodeViews(db, companyId),
    upsertRoute: (
      companyId: string,
      input: Parameters<typeof upsertFounderRoute>[2],
      actorUserId: string | null,
    ) => upsertFounderRoute(db, companyId, input, actorUserId),
    updateRoute: (
      companyId: string,
      routeId: string,
      input: Parameters<typeof updateFounderRoute>[3],
      actorUserId: string | null,
    ) => updateFounderRoute(db, companyId, routeId, input, actorUserId),
  };
}
