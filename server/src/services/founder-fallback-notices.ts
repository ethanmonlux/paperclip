import { and, asc, desc, eq, inArray, isNull, like, notExists, or, sql } from "drizzle-orm";
import type { LiveEvent } from "@paperclipai/shared";
import {
  agents,
  chatConversations,
  chatDeliveries,
  chatEndpoints,
  chatIdentityLinks,
  chatPublications,
  companies,
  companyMemberships,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
  type Db,
} from "@paperclipai/db";
import { authorizationService } from "./authorization.js";
import { OPERATOR_UNCONFIRMED_DELIVERY_CANCELLATION } from "./chat-publication-errors.js";
import { notifyChatPublicationWork } from "./chat-work-notifications.js";
import { projectSafeChatPublication } from "./chat-publication-projection.js";
import { publicChatTaskUrl } from "./chat-task-url.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "./delivery-work-notifications.js";
import { subscribeAllCompanyLiveEvents } from "./live-events.js";
import { subscribeTaskDrainChanges } from "./task-admission.js";

/**
 * Deterministic founder alerts (FAC-597 B1, STA-219).
 *
 * The founder hears only about items they can act on: a decision addressed to
 * them on another task, or an escalation to the DM agent that nobody picked up.
 * Agent availability, pause, recovery and fallback mode are internal state and
 * never reach the founder; they belong on the Console. Each alert is one plain
 * line per item with one link to the card, at most five per message. When an
 * alerted item resolves, one short "Done" line retracts it. A still-pending
 * item is reminded at most every four hours, and nothing but a critical item
 * is sent between 23:00 and 07:00 Mountain. Whether the DM agent is available
 * changes nothing the founder sees.
 *
 * Notices are model-free and go through the native outbox, so retry, UNKNOWN,
 * restart and idempotency stay native. Each notice is re-proved at the
 * transport claim and cancelled before any I/O when it no longer holds.
 * Disabled unless explicitly configured.
 *
 * The sweep is not a poll. It runs at startup, on wake hints from agent, run,
 * interaction and chat-configuration changes, and at the real deadline when a
 * known condition crosses a bound. With no such deadline it stays idle.
 */

export const FOUNDER_FALLBACK_KEY_PREFIX = "founder-fallback:v1:";
const DEFAULT_BOUND_MINUTES = 20;
const MIN_BOUND_MINUTES = 5;
const MAX_BOUND_MINUTES = 360;
const MAX_ITEMS_PER_SWEEP = 5;
const MINUTE_MS = 60_000;
export const FOUNDER_REMINDER_INTERVAL_MS = 4 * 60 * MINUTE_MS;
/** Reminders after the first delivered alert of one item. */
export const MAX_FOUNDER_REMINDERS = 2;
/** Published alerts this recent are checked for a resolution to retract. */
const RETRACTION_WINDOW_MS = 14 * 24 * 60 * MINUTE_MS;
export const FOUNDER_TIME_ZONE = "America/Denver";
const QUIET_START_HOUR = 23;
const QUIET_END_HOUR = 7;
const FAILED_RUN_STATUSES = ["failed", "timed_out"];
const IN_FLIGHT_STATES: (typeof chatPublications.$inferSelect.state)[] = ["pending", "retry", "streaming", "awaiting_consent"];
const REACHED_STATES: (typeof chatPublications.$inferSelect.state)[] = ["published", "delivery_unknown"];
/** Re-arms of one notice cancelled before any provider I/O; later cancellations stay final and visible. */
export const MAX_FOUNDER_FALLBACK_REARMS = 20;

export type FounderFallbackSettings = { enabled: boolean; boundMs: number };

export function founderFallbackSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): FounderFallbackSettings {
  const minutes = Number(env.PAPERCLIP_FOUNDER_FALLBACK_BOUND_MINUTES);
  const bounded = Number.isInteger(minutes)
    ? Math.min(MAX_BOUND_MINUTES, Math.max(MIN_BOUND_MINUTES, minutes))
    : DEFAULT_BOUND_MINUTES;
  return { enabled: env.PAPERCLIP_FOUNDER_FALLBACK_NOTICES === "true", boundMs: bounded * MINUTE_MS };
}

type Tx = Db;
type Endpoint = typeof chatEndpoints.$inferSelect;
type Agent = typeof agents.$inferSelect;
type Interaction = typeof issueThreadInteractions.$inferSelect;
type Target = {
  endpoint: Endpoint;
  agent: Agent;
  founderUserId: string;
  conversationId: string;
  issueId: string;
};
type Unavailability = { anchor: string; state: "error" | "paused" | "terminated"; since: Date; runId: string | null };

/**
 * `asks` is one message listing up to five items; `done` retracts one item.
 * `agent`, `recovered` and single `item` keys are retired formats: they still
 * parse so queued rows are cancelled at the claim and delivered rows still
 * count as an alert of their item, but none is created any more.
 *
 * `attempt` is absent on the first row. A later row of the same identity gets
 * the next attempt suffix, so each row keeps its own effect identity and the
 * unique key still deduplicates.
 */
export type FounderFallbackKey =
  | { endpointId: string; kind: "agent" | "recovered"; agentId: string; anchor: string; attempt?: number }
  | { endpointId: string; kind: "item" | "done"; interactionId: string; attempt?: number }
  | { endpointId: string; kind: "asks"; interactionIds: string[]; attempt?: number };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const KEY_RE = new RegExp(
  `^founder-fallback:v1:(${UUID}):(?:(agent|recovered):(${UUID}):(error\\.(?:${UUID}|none)|paused\\.\\d{1,15}|terminated)|(item|done):(${UUID})|asks:(${UUID}(?:\\+${UUID}){0,${MAX_ITEMS_PER_SWEEP - 1}}))(?::a([1-9]\\d{0,2}))?$`,
);

export function founderFallbackKey(key: FounderFallbackKey): string {
  const base = key.kind === "item" || key.kind === "done"
    ? `${FOUNDER_FALLBACK_KEY_PREFIX}${key.endpointId}:${key.kind}:${key.interactionId}`
    : key.kind === "asks"
      ? `${FOUNDER_FALLBACK_KEY_PREFIX}${key.endpointId}:asks:${key.interactionIds.join("+")}`
      : `${FOUNDER_FALLBACK_KEY_PREFIX}${key.endpointId}:${key.kind}:${key.agentId}:${key.anchor}`;
  return key.attempt ? `${base}:a${key.attempt}` : base;
}

export function parseFounderFallbackKey(value: string): FounderFallbackKey | null {
  const match = KEY_RE.exec(value);
  if (!match) return null;
  const attempt = match[8] ? { attempt: Number(match[8]) } : {};
  if (match[7]) {
    const interactionIds = match[7].split("+");
    if (new Set(interactionIds).size !== interactionIds.length) return null;
    return { endpointId: match[1]!, kind: "asks", interactionIds, ...attempt };
  }
  return match[5]
    ? { endpointId: match[1]!, kind: match[5] as "item" | "done", interactionId: match[6]!, ...attempt }
    : { endpointId: match[1]!, kind: match[2] as "agent" | "recovered", agentId: match[3]!, anchor: match[4]!, ...attempt };
}

function withoutAttempt(key: FounderFallbackKey): FounderFallbackKey {
  const { attempt: _attempt, ...base } = key;
  return base as FounderFallbackKey;
}

function withAttempt(base: string, attempt: number) {
  return attempt ? `${base}:a${attempt}` : base;
}

/** Interactions an alert row covers: an `asks` batch or a retired single `item`. */
function alertedInteractionIds(key: FounderFallbackKey | null): string[] {
  if (key?.kind === "asks") return key.interactionIds;
  if (key?.kind === "item") return [key.interactionId];
  return [];
}

type PublicationOutcome = Pick<typeof chatPublications.$inferSelect, "state" | "publishedAt" | "providerMessageId" | "redactedError">;

/**
 * Only a cancellation the outbox made before provider I/O proves the founder
 * never saw the notice. An operator's cancellation of `delivery_unknown` may
 * follow a real delivery, so it is never re-armed; neither are failed rows.
 */
export function founderFallbackDefinitelyUnsent(row: PublicationOutcome) {
  return row.state === "cancelled" && !row.publishedAt && !row.providerMessageId
    && row.redactedError !== OPERATOR_UNCONFIRMED_DELIVERY_CANCELLATION;
}

export function isFounderFallbackPublication(publication: { idempotencyKey: string }) {
  return publication.idempotencyKey.startsWith(FOUNDER_FALLBACK_KEY_PREFIX);
}

function founderHour(date: Date) {
  const hour = new Intl.DateTimeFormat("en-US", { timeZone: FOUNDER_TIME_ZONE, hour: "numeric", hourCycle: "h23" })
    .formatToParts(date).find(part => part.type === "hour")?.value;
  return Number(hour) % 24;
}

/** 23:00 to 07:00 founder local time. */
export function inFounderQuietHours(date: Date) {
  const hour = founderHour(date);
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

/** The first quarter hour at or after `date` outside quiet hours (07:00 local). */
export function founderQuietHoursEnd(date: Date) {
  const step = 15 * MINUTE_MS;
  let at = Math.ceil(date.getTime() / step) * step;
  while (inFounderQuietHours(new Date(at))) at += step;
  return at;
}

function founderLocalTime(date: Date, now: Date) {
  const sameDay = now.getTime() - date.getTime() < 20 * 60 * MINUTE_MS;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: FOUNDER_TIME_ZONE, hour: "numeric", minute: "2-digit", timeZoneName: "short",
    ...(sameDay ? {} : { weekday: "short" }),
  }).format(date);
}

function waited(ms: number) {
  const minutes = Math.max(0, Math.floor(ms / MINUTE_MS));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function clip(value: string | null | undefined, max: number) {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const ESTIMATE_RE = /(?:~|≈|about\s+|approx\.?\s+)?\b(\d{1,3})\s*-?\s*(min(?:ute)?s?|h(?:ou)?rs?|hours?)\b/i;
const PC_RE = /\b(?:at (?:the |your )?(?:pc|desk|computer)|pc|desktop|laptop|computer)\b/i;
const PHONE_RE = /\b(?:phone|mobile)\b/i;

/** Effort and place, only when the card states them; never invented. */
export function founderAskHints(text: string): { estimate: string | null; where: "PC" | "phone" | null } {
  const match = ESTIMATE_RE.exec(text);
  const estimate = match ? `~${Number(match[1])} ${/^h/i.test(match[2]!) ? "h" : "min"}` : null;
  const where = PC_RE.test(text) ? "PC" : PHONE_RE.test(text) ? "phone" : null;
  return { estimate, where };
}

/**
 * The founder DM of the endpoint's own agent, or null when none qualifies.
 * A DM stays a target after its task closes, because the outbox still delivers
 * there; only a published `/close` or `/new` task control ends it, matching the
 * outbox's own completed-conversation guard. Open conversations come first.
 */
async function resolveTarget(tx: Tx, endpoint: Endpoint): Promise<Target | null> {
  if (endpoint.status !== "active" || !endpoint.allowDirectMessages || !endpoint.assignedAgentId) return null;
  const [agent] = await tx.select().from(agents)
    .where(and(eq(agents.id, endpoint.assignedAgentId), eq(agents.companyId, endpoint.companyId)));
  if (!agent) return null;
  const candidates = await tx.select({ conversation: chatConversations }).from(chatConversations)
    .innerJoin(issues, and(eq(issues.id, chatConversations.issueId), eq(issues.companyId, chatConversations.companyId)))
    .where(and(
      eq(chatConversations.companyId, endpoint.companyId),
      eq(chatConversations.endpointId, endpoint.id),
      eq(chatConversations.isDirectMessage, true),
      or(
        inArray(chatConversations.state, ["active", "waiting"]),
        and(
          eq(chatConversations.state, "completed"),
          notExists(tx.select({ id: chatPublications.id }).from(chatPublications).where(and(
            eq(chatPublications.conversationId, chatConversations.id),
            eq(chatPublications.state, "published"),
            or(like(chatPublications.idempotencyKey, "control:new:%"), like(chatPublications.idempotencyKey, "control:close:%")),
          ))),
        ),
      ),
      eq(issues.assigneeAgentId, agent.id),
    ))
    .orderBy(sql`case when ${chatConversations.state} = 'completed' then 1 else 0 end`,
      sql`${chatConversations.lastActivityAt} desc nulls last`,
      desc(chatConversations.sessionGeneration), asc(chatConversations.id));
  for (const { conversation } of candidates) {
    const founderUserId = await soleFounderRecipient(tx, endpoint, conversation.id);
    if (founderUserId) {
      return { endpoint, agent, founderUserId, conversationId: conversation.id, issueId: conversation.issueId };
    }
  }
  return null;
}

/** Every known DM sender must link to the same active company owner. */
async function soleFounderRecipient(tx: Tx, endpoint: Endpoint, conversationId: string): Promise<string | null> {
  const recipients = await tx.selectDistinct({ principalId: chatDeliveries.principalId }).from(chatDeliveries)
    .where(and(
      eq(chatDeliveries.companyId, endpoint.companyId),
      eq(chatDeliveries.conversationId, conversationId),
      inArray(chatDeliveries.eventKind, ["mention", "message", "direct_message"]),
    ));
  if (!recipients.length || recipients.some(row => !row.principalId)) return null;
  const users = new Set<string>();
  for (const { principalId } of recipients) {
    const [link] = await tx.select({ userId: chatIdentityLinks.paperclipUserId }).from(chatIdentityLinks).where(and(
      eq(chatIdentityLinks.companyId, endpoint.companyId),
      eq(chatIdentityLinks.endpointId, endpoint.id),
      eq(chatIdentityLinks.principalId, principalId!),
      eq(chatIdentityLinks.status, "linked"),
      isNull(chatIdentityLinks.revokedAt),
    ));
    if (!link?.userId) return null;
    users.add(link.userId);
  }
  if (users.size !== 1) return null;
  const [userId] = [...users];
  const [owner] = await tx.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
    eq(companyMemberships.companyId, endpoint.companyId),
    eq(companyMemberships.principalType, "user"),
    eq(companyMemberships.principalId, userId!),
    eq(companyMemberships.status, "active"),
    eq(companyMemberships.membershipRole, "owner"),
  ));
  return owner ? userId! : null;
}

/** A durable, restart-stable anchor for the agent's current unavailability. */
async function unavailability(tx: Tx, agent: Agent): Promise<Unavailability | null> {
  if (agent.status === "terminated") return { anchor: "terminated", state: "terminated", since: agent.updatedAt, runId: null };
  if (agent.status === "paused") {
    const since = agent.pausedAt ?? agent.updatedAt;
    return { anchor: `paused.${since.getTime()}`, state: "paused", since, runId: null };
  }
  if (agent.status !== "error") return null;
  const [run] = await tx.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id)))
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
  if (run && FAILED_RUN_STATUSES.includes(run.status)) {
    return { anchor: `error.${run.id}`, state: "error", since: run.finishedAt ?? run.updatedAt ?? agent.updatedAt, runId: run.id };
  }
  return { anchor: "error.none", state: "error", since: agent.updatedAt, runId: null };
}

function eligible(state: Unavailability | null, now: Date, boundMs: number): state is Unavailability {
  return !!state && now.getTime() - state.since.getTime() >= boundMs;
}

/**
 * The addressed agent never started a run on the escalation's own task after
 * the escalation was created. A native addressed interaction wakes its
 * addressee on that task, so only such a run is attributable pickup. Runs on
 * other tasks, or bound to no task, prove nothing about this escalation.
 */
async function escalationMissed(tx: Tx, agent: Agent, interaction: Interaction, now: Date, boundMs: number) {
  if (now.getTime() - interaction.createdAt.getTime() < boundMs) return false;
  const [run] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, agent.companyId),
    eq(heartbeatRuns.agentId, agent.id),
    sql`${heartbeatRuns.startedAt} >= ${interaction.createdAt.toISOString()}::timestamptz`,
    sql`(${heartbeatRuns.issueId} = ${interaction.issueId}::uuid or coalesce(
      ${heartbeatRuns.nativeIssueId}::text,
      nullif(${heartbeatRuns.contextSnapshot}->>'issueId', ''),
      nullif(${heartbeatRuns.contextSnapshot}->>'taskId', '')
    ) = ${interaction.issueId}::text)`,
  )).limit(1);
  return !run;
}

/** The founder's own task-read decision, never widened by instance admin. */
async function founderCanReadIssue(tx: Tx, target: Target, issueId: string) {
  const decision = await authorizationService(tx).decide({
    actor: { type: "board", userId: target.founderUserId, source: "session", ignoreInstanceAdmin: true },
    action: "issue:read",
    resource: { type: "issue", companyId: target.endpoint.companyId, issueId },
  });
  return decision.allowed;
}

type ItemReason = { kind: "unavailable"; state: Unavailability } | { kind: "missed" } | { kind: "awaiting_founder" };

async function itemReason(
  tx: Tx, target: Target, interaction: Interaction, state: Unavailability | null, now: Date, boundMs: number,
): Promise<ItemReason | null> {
  if (interaction.status !== "pending" || interaction.companyId !== target.endpoint.companyId) return null;
  // Items on the DM task itself already publish natively to this conversation.
  if (interaction.issueId === target.issueId) return null;
  const toAgent = interaction.addresseeAgentId === target.agent.id;
  const toFounder = interaction.addresseeUserId === target.founderUserId;
  if (!toAgent && !toFounder) return null;
  if (!(await founderCanReadIssue(tx, target, interaction.issueId))) return null;
  // Nothing routes a founder decision on another task into this DM natively,
  // so the agent's availability does not decide whether the founder hears of it.
  if (toFounder) return now.getTime() - interaction.createdAt.getTime() >= boundMs ? { kind: "awaiting_founder" } : null;
  if (eligible(state, now, boundMs)) return { kind: "unavailable", state };
  if (!state && await escalationMissed(tx, target.agent, interaction, now, boundMs)) return { kind: "missed" };
  return null;
}

type IssueRef = { identifier: string | null; title: string | null; priority: string; prefix: string | null };

async function issueRef(tx: Tx, interaction: Interaction): Promise<IssueRef | null> {
  const [row] = await tx.select({
    identifier: issues.identifier, title: issues.title, priority: issues.priority, prefix: companies.issuePrefix,
  }).from(issues).innerJoin(companies, eq(companies.id, issues.companyId))
    .where(and(eq(issues.id, interaction.issueId), eq(issues.companyId, interaction.companyId)));
  return row ?? null;
}

function interactionText(interaction: Interaction) {
  const payload = interaction.payload as { prompt?: unknown; question?: unknown } | null;
  const prompt = typeof payload?.prompt === "string" ? payload.prompt : typeof payload?.question === "string" ? payload.question : null;
  return interaction.title ?? interaction.summary ?? prompt ?? interaction.kind;
}

/** One plain line the founder can act on, without agent or fallback state. */
function askLine(interaction: Interaction, reason: ItemReason) {
  const ask = clip(interactionText(interaction), 120);
  return reason.kind === "awaiting_founder" ? ask : `Stuck, needs a board action: ${ask}`;
}

function cardLink(interaction: Interaction, ref: IssueRef | null) {
  return publicChatTaskUrl(interaction.issueId, { prefix: ref?.prefix ?? null, identifier: ref?.identifier ?? null })
    ?? ref?.identifier ?? null;
}

type Ask = { interaction: Interaction; reason: ItemReason; ref: IssueRef | null; reminder: boolean; sequence: number };

function askText(asks: Ask[], now: Date) {
  return asks.map(({ interaction, reason, ref, reminder }) => {
    const hints = founderAskHints(`${interaction.title ?? ""} ${interaction.summary ?? ""} ${interactionText(interaction)}`);
    const parts = [
      `${reminder ? "[Still needs you]" : "[Needs you]"} ${askLine(interaction, reason)}`,
      hints.estimate,
      hints.where,
      `waiting ${waited(now.getTime() - interaction.createdAt.getTime())} (since ${founderLocalTime(interaction.createdAt, now)})`,
    ].filter(Boolean);
    const link = cardLink(interaction, ref);
    return [parts.join(" · "), link].filter(Boolean).join("\n");
  }).join("\n\n");
}

function doneText(interaction: Interaction, ref: IssueRef | null) {
  const ask = clip(interactionText(interaction), 120);
  return `[Done] No action needed: ${ask}${ref?.identifier ? ` (${ref.identifier})` : ""}`;
}

function noticePayload(text: string) {
  return projectSafeChatPublication({ classification: "external", source: "safe_milestone", text });
}

const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

type AlertRow = Pick<typeof chatPublications.$inferSelect,
  "idempotencyKey" | "state" | "publishedAt" | "providerMessageId" | "redactedError" | "createdAt" | "updatedAt">;
type Coverage = { rows: number; inFlight: boolean; blocked: boolean; unsent: number; lastReachedAt: number | null; reached: number };

const alertColumns = {
  idempotencyKey: chatPublications.idempotencyKey,
  state: chatPublications.state,
  publishedAt: chatPublications.publishedAt,
  providerMessageId: chatPublications.providerMessageId,
  redactedError: chatPublications.redactedError,
  createdAt: chatPublications.createdAt,
  updatedAt: chatPublications.updatedAt,
};

/** Alert rows on one endpoint that cover any of `interactionIds`, by interaction. */
async function alertCoverage(tx: Tx, companyId: string, endpointId: string, interactionIds: string[]) {
  const coverage = new Map<string, Coverage>();
  if (!interactionIds.length) return coverage;
  const wanted = new Set(interactionIds);
  const rows: AlertRow[] = await tx.select(alertColumns).from(chatPublications).where(and(
    eq(chatPublications.companyId, companyId),
    eq(chatPublications.endpointId, endpointId),
    or(
      like(chatPublications.idempotencyKey, `${FOUNDER_FALLBACK_KEY_PREFIX}${endpointId}:asks:%`),
      like(chatPublications.idempotencyKey, `${FOUNDER_FALLBACK_KEY_PREFIX}${endpointId}:item:%`),
    ),
    or(...interactionIds.map(id => like(chatPublications.idempotencyKey, `%${id}%`))),
  ));
  for (const row of rows) {
    const key = parseFounderFallbackKey(row.idempotencyKey);
    if (!key || key.endpointId !== endpointId) continue;
    for (const id of alertedInteractionIds(key)) {
      if (!wanted.has(id)) continue;
      const entry = coverage.get(id) ?? { rows: 0, inFlight: false, blocked: false, unsent: 0, lastReachedAt: null, reached: 0 };
      entry.rows += 1;
      if (IN_FLIGHT_STATES.includes(row.state)) entry.inFlight = true;
      else if (founderFallbackDefinitelyUnsent(row)) entry.unsent += 1;
      else if (REACHED_STATES.includes(row.state)) {
        entry.reached += 1;
        const at = (row.publishedAt ?? row.updatedAt ?? row.createdAt).getTime();
        entry.lastReachedAt = Math.max(entry.lastReachedAt ?? at, at);
      } else entry.blocked = true;
      coverage.set(id, entry);
    }
  }
  return coverage;
}

type AskPlan = { send: "first" | "reminder" } | { inFlight: true } | { dueAt: number } | null;

/**
 * One item's next alert: the first one, a reminder at most every four hours
 * after a delivered one, or nothing while one is in flight, once a row failed
 * or may have been delivered without proof, or after the reminder limit.
 */
function askPlan(coverage: Coverage | undefined, now: Date): AskPlan {
  if (!coverage) return { send: "first" };
  if (coverage.inFlight) return { inFlight: true };
  if (coverage.blocked) return null;
  if (!coverage.reached) return coverage.unsent < MAX_FOUNDER_FALLBACK_REARMS ? { send: "first" } : null;
  if (coverage.reached > MAX_FOUNDER_REMINDERS) return null;
  const dueAt = coverage.lastReachedAt! + FOUNDER_REMINDER_INTERVAL_MS;
  return dueAt <= now.getTime() ? { send: "reminder" } : { dueAt };
}

export function createFounderFallbackNotices(db: Db, settings: FounderFallbackSettings, clock: () => Date = () => new Date()) {
  /**
   * Read-only receipt for an interaction on an issue the caller may read:
   * the live setting, each qualifying founder DM and the exact outbox rows.
   * Provider links and error text stay behind endpoint access.
   */
  async function interactionReceipt(companyId: string, issueId: string, interactionId: string) {
    const [interaction] = await db.select().from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, companyId),
      eq(issueThreadInteractions.issueId, issueId),
      eq(issueThreadInteractions.id, interactionId),
    ));
    if (!interaction) return null;
    const now = clock();
    const endpoints = await db.select().from(chatEndpoints).where(and(
      eq(chatEndpoints.companyId, companyId),
      eq(chatEndpoints.status, "active"),
      eq(chatEndpoints.allowDirectMessages, true),
    ));
    const targets = [];
    for (const endpoint of endpoints) {
      const target = await resolveTarget(db, endpoint);
      if (!target || (interaction.addresseeUserId !== target.founderUserId && interaction.addresseeAgentId !== target.agent.id)) continue;
      const reason = await itemReason(db, target, interaction, await unavailability(db, target.agent), now, settings.boundMs);
      targets.push({ endpointId: endpoint.id, conversationId: target.conversationId, eligible: !!reason, reason: reason?.kind ?? null });
    }
    const rows = await db.select({
      id: chatPublications.id,
      endpointId: chatPublications.endpointId,
      conversationId: chatPublications.conversationId,
      idempotencyKey: chatPublications.idempotencyKey,
      state: chatPublications.state,
      attempts: chatPublications.attempts,
      nextAttemptAt: chatPublications.nextAttemptAt,
      createdAt: chatPublications.createdAt,
      publishedAt: chatPublications.publishedAt,
    }).from(chatPublications).where(and(
      eq(chatPublications.companyId, companyId),
      like(chatPublications.idempotencyKey, `${FOUNDER_FALLBACK_KEY_PREFIX}%`),
      like(chatPublications.idempotencyKey, `%${interactionId}%`),
    )).orderBy(asc(chatPublications.createdAt), asc(chatPublications.idempotencyKey));
    return {
      configured: settings.enabled,
      boundMs: settings.boundMs,
      interactionStatus: interaction.status,
      targets,
      publications: rows.filter(row => {
        const key = parseFounderFallbackKey(row.idempotencyKey);
        if (!key || key.endpointId !== row.endpointId) return false;
        return key.kind === "done" ? key.interactionId === interactionId : alertedInteractionIds(key).includes(interactionId);
      }),
    };
  }

  /**
   * Re-prove one founder publication. Called inside the outbox transport
   * claim, with the publication row locked, and before every insert.
   */
  async function authorizeFounderFallbackPublication(
    tx: Tx,
    publication: {
      idempotencyKey: string; endpointId: string; conversationId: string; issueId: string; companyId: string;
      payload?: unknown;
    },
  ): Promise<boolean> {
    if (!settings.enabled) return false;
    const key = parseFounderFallbackKey(publication.idempotencyKey);
    // Agent availability, recovery and the old per-item format are retired.
    if (!key || key.endpointId !== publication.endpointId || (key.kind !== "asks" && key.kind !== "done")) return false;
    const [endpoint] = await tx.select().from(chatEndpoints)
      .where(and(eq(chatEndpoints.id, key.endpointId), eq(chatEndpoints.companyId, publication.companyId)));
    const target = endpoint ? await resolveTarget(tx, endpoint) : null;
    if (!target || target.conversationId !== publication.conversationId || target.issueId !== publication.issueId) return false;
    const load = async (id: string) => (await tx.select().from(issueThreadInteractions)
      .where(and(eq(issueThreadInteractions.id, id), eq(issueThreadInteractions.companyId, publication.companyId))))[0];
    if (key.kind === "done") {
      const interaction = await load(key.interactionId);
      if (!interaction || interaction.status === "pending" || interaction.issueId === target.issueId) return false;
      if (!(await founderCanReadIssue(tx, target, interaction.issueId))) return false;
      const coverage = (await alertCoverage(tx, publication.companyId, key.endpointId, [interaction.id])).get(interaction.id);
      return !!coverage?.reached;
    }
    const now = clock();
    const state = await unavailability(tx, target.agent);
    // Every listed item must still need the founder; otherwise the whole
    // message is cancelled before I/O and the rest are listed again.
    for (const id of key.interactionIds) {
      const interaction = await load(id);
      if (!interaction || !(await itemReason(tx, target, interaction, state, now, settings.boundMs))) return false;
    }
    return true;
  }

  async function insert(tx: Tx, target: Target, key: string, text: string) {
    const row = {
      companyId: target.endpoint.companyId, endpointId: target.endpoint.id,
      conversationId: target.conversationId, issueId: target.issueId, idempotencyKey: key,
    };
    if (!(await authorizeFounderFallbackPublication(tx, row))) return 0;
    await notifyChatPublicationWork(tx);
    return (await tx.insert(chatPublications).values({ ...row, payload: noticePayload(text), state: "pending" })
      .onConflictDoNothing().returning({ id: chatPublications.id })).length;
  }

  /**
   * For each base key, the attempt to insert next, or null when a row of that
   * notice is still open, may have reached the founder, failed, or used up its
   * re-arms. Re-arming applies only while every earlier row was cancelled
   * before provider I/O.
   */
  async function nextAttempts(tx: Tx, companyId: string, bases: string[]) {
    const plan = new Map<string, number | null>();
    if (!bases.length) return plan;
    const firsts = new Map((await tx.select(alertColumns).from(chatPublications).where(and(
      eq(chatPublications.companyId, companyId),
      inArray(chatPublications.idempotencyKey, bases),
    ))).map(row => [row.idempotencyKey, row]));
    for (const base of bases) {
      const first = firsts.get(base);
      if (!first) { plan.set(base, 0); continue; }
      if (!founderFallbackDefinitelyUnsent(first)) { plan.set(base, null); continue; }
      const retries = (await tx.select(alertColumns).from(chatPublications).where(and(
        eq(chatPublications.companyId, companyId),
        like(chatPublications.idempotencyKey, `${base}:a%`),
      ))).flatMap(row => {
        const key = parseFounderFallbackKey(row.idempotencyKey);
        return key?.attempt && founderFallbackKey(withoutAttempt(key)) === base ? [{ row, attempt: key.attempt }] : [];
      });
      const settled = retries.every(({ row }) => founderFallbackDefinitelyUnsent(row));
      plan.set(base, settled && retries.length < MAX_FOUNDER_FALLBACK_REARMS
        ? Math.max(0, ...retries.map(retry => retry.attempt)) + 1
        : null);
    }
    return plan;
  }

  /**
   * Plans and inserts one endpoint's notices in a transaction holding the
   * endpoint's advisory lock, so concurrent sweeps and restarts cannot list one
   * item in two messages.
   */
  async function sweepTarget(target: Target, now: Date) {
    let dueAt: number | null = null;
    const due = (at: number) => { dueAt = dueAt === null ? at : Math.min(dueAt, at); };
    const companyId = target.endpoint.companyId;
    const endpointId = target.endpoint.id;
    const quiet = inFounderQuietHours(now);
    const result = await db.transaction(async raw => {
      const tx = raw as unknown as Tx;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`founder-fallback:${endpointId}`}))`);
      let inserted = 0;
      let awaitingOutbox = false;
      const state = await unavailability(tx, target.agent);
      const boundAt = state ? state.since.getTime() + settings.boundMs : null;

      const pending = await tx.select().from(issueThreadInteractions).where(and(
        eq(issueThreadInteractions.companyId, companyId),
        eq(issueThreadInteractions.status, "pending"),
        sql`${issueThreadInteractions.issueId} <> ${target.issueId}`,
        sql`(${issueThreadInteractions.addresseeAgentId} = ${target.agent.id} or ${issueThreadInteractions.addresseeUserId} = ${target.founderUserId})`,
      )).orderBy(asc(issueThreadInteractions.createdAt), asc(issueThreadInteractions.id));
      const coverage = await alertCoverage(tx, companyId, endpointId, pending.map(row => row.id));
      const asks: Ask[] = [];
      for (const interaction of pending) {
        if (interaction.createdAt > now) continue;
        const plan = askPlan(coverage.get(interaction.id), now);
        if (!plan) continue;
        if ("inFlight" in plan) { awaitingOutbox = true; continue; }
        if ("dueAt" in plan) { due(plan.dueAt); continue; }
        // An escalation to an unavailable agent qualifies at the outage bound;
        // a founder decision, or one to an available agent, at its own age.
        const missedAt = interaction.createdAt.getTime() + settings.boundMs;
        const qualifiesAt = interaction.addresseeUserId !== target.founderUserId && boundAt !== null ? boundAt : missedAt;
        if (qualifiesAt > now.getTime()) due(qualifiesAt);
        const reason = await itemReason(tx, target, interaction, state, now, settings.boundMs);
        if (!reason) continue;
        const ref = await issueRef(tx, interaction);
        if (quiet && ref?.priority !== "critical") { due(founderQuietHoursEnd(now)); continue; }
        asks.push({ interaction, reason, ref, reminder: plan.send === "reminder", sequence: coverage.get(interaction.id)?.rows ?? 0 });
      }
      asks.sort((a, b) => (PRIORITY_RANK[a.ref?.priority ?? "medium"] ?? 2) - (PRIORITY_RANK[b.ref?.priority ?? "medium"] ?? 2)
        || a.interaction.createdAt.getTime() - b.interaction.createdAt.getTime());
      const batch = asks.slice(0, MAX_ITEMS_PER_SWEEP);
      if (asks.length > batch.length) due(now.getTime());
      if (batch.length) {
        // Unique per item set: any earlier row of this set raised each item's count.
        const attempt = Math.max(...batch.map(ask => ask.sequence));
        const key = founderFallbackKey({ endpointId, kind: "asks", interactionIds: batch.map(ask => ask.interaction.id), ...(attempt ? { attempt } : {}) });
        inserted += await insert(tx, target, key, askText(batch, now));
      }

      // Retract each alerted item that has since resolved, once.
      const alerted = await tx.select({ idempotencyKey: chatPublications.idempotencyKey }).from(chatPublications).where(and(
        eq(chatPublications.companyId, companyId),
        eq(chatPublications.endpointId, endpointId),
        or(
          like(chatPublications.idempotencyKey, `${FOUNDER_FALLBACK_KEY_PREFIX}${endpointId}:asks:%`),
          like(chatPublications.idempotencyKey, `${FOUNDER_FALLBACK_KEY_PREFIX}${endpointId}:item:%`),
        ),
        inArray(chatPublications.state, REACHED_STATES),
        sql`${chatPublications.createdAt} >= ${new Date(now.getTime() - RETRACTION_WINDOW_MS).toISOString()}::timestamptz`,
      ));
      const alertedIds = [...new Set(alerted.flatMap(row => alertedInteractionIds(parseFounderFallbackKey(row.idempotencyKey))))];
      const resolved = alertedIds.length ? await tx.select().from(issueThreadInteractions).where(and(
        eq(issueThreadInteractions.companyId, companyId),
        inArray(issueThreadInteractions.id, alertedIds),
        sql`${issueThreadInteractions.status} <> 'pending'`,
      )).orderBy(asc(issueThreadInteractions.updatedAt), asc(issueThreadInteractions.id)) : [];
      const doneKeys = resolved.map(interaction => founderFallbackKey({ endpointId, kind: "done", interactionId: interaction.id }));
      const donePlan = await nextAttempts(tx, companyId, doneKeys);
      let dones = 0;
      for (const [index, interaction] of resolved.entries()) {
        const attempt = donePlan.get(doneKeys[index]!);
        if (attempt == null) continue;
        if (quiet) { due(founderQuietHoursEnd(now)); break; }
        if (dones >= MAX_ITEMS_PER_SWEEP) { due(now.getTime()); break; }
        const count = await insert(tx, target, withAttempt(doneKeys[index]!, attempt), doneText(interaction, await issueRef(tx, interaction)));
        dones += count;
        inserted += count;
      }
      return { inserted, awaitingOutbox };
    });
    return { ...result, dueAt: dueAt as number | null };
  }

  /**
   * `nextDueAt` is the earliest real deadline of a known condition, or null.
   * `awaitingOutbox` means an alert is still in flight, so the outcome of that
   * outbox row (delivered, or cancelled and listed again) decides the next step.
   */
  async function sweep(signal?: AbortSignal): Promise<{ targets: number; inserted: number; nextDueAt: number | null; awaitingOutbox: boolean }> {
    if (!settings.enabled) return { targets: 0, inserted: 0, nextDueAt: null, awaitingOutbox: false };
    const now = clock();
    const endpoints = await db.select({ endpoint: chatEndpoints }).from(chatEndpoints)
      .innerJoin(companies, eq(companies.id, chatEndpoints.companyId))
      .where(and(
        eq(companies.status, "active"),
        eq(chatEndpoints.status, "active"),
        eq(chatEndpoints.allowDirectMessages, true),
        sql`${chatEndpoints.assignedAgentId} is not null`,
      ))
      .orderBy(asc(chatEndpoints.id));
    let targets = 0, inserted = 0, awaitingOutbox = false;
    let nextDueAt: number | null = null;
    for (const { endpoint } of endpoints) {
      signal?.throwIfAborted();
      const target = await resolveTarget(db, endpoint);
      if (!target) continue;
      targets += 1;
      const result = await sweepTarget(target, now);
      inserted += result.inserted;
      awaitingOutbox ||= result.awaitingOutbox;
      if (result.dueAt !== null) nextDueAt = nextDueAt === null ? result.dueAt : Math.min(nextDueAt, result.dueAt);
    }
    return { targets, inserted, nextDueAt, awaitingOutbox };
  }

  return { authorizeFounderFallbackPublication, sweep, interactionReceipt };
}

/**
 * Wake hints for facts the sweep reads: agent status, run starts and failures
 * (including pickup of an escalation), interactions, and chat endpoint, link
 * or membership changes. Rows remain the source of truth.
 */
export function isFounderFallbackWakeEvent(event: Pick<LiveEvent, "type" | "payload">) {
  if (event.type === "agent.status" || event.type === "heartbeat.run.status") return true;
  if (event.type !== "activity.logged") return false;
  const action = typeof event.payload.action === "string" ? event.payload.action : "";
  return event.payload.entityType === "agent" || action.includes("interaction")
    || /^(agent|chat|company_member)[._]/.test(action);
}

/**
 * Runs once at startup to reconstruct from durable rows, then only on a wake
 * hint or at the sweep's own next deadline.
 *
 * Every hint records an owed sweep, which only a sweep that starts while
 * admission is open clears, and a failed sweep restores. Admission may skip the
 * run altogether (idle drain reconciles without dispatching, warm standby skips
 * it), so the obligation lives here rather than in the run: while it is owed
 * the coordinator retries without querying, and the end of a drain wakes the
 * worker at once. Without one, a pass makes no query unless the deadline is due.
 *
 * Outbox settlement is observed from before each sweep's read until a sweep
 * finds no notice in flight. A row that settles while the sweep runs marks the
 * worker dirty, and the coordinator sweeps again; one that settled earlier is
 * already in the read. Once stopped, no sweep starts or attaches an observer.
 */
export function registerFounderFallbackNoticeWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: ReturnType<typeof createFounderFallbackNotices>,
  canRun: () => boolean,
  retryMs: number,
  owner: object,
  subscribeOutbox: (wake: () => void) => () => void =
    wake => subscribeDeliveryWork(owner, DELIVERY_QUEUES.chatPublications, wake),
) {
  let next: number | null = null;
  // Startup reconstruction is the first obligation.
  let owed = true;
  let stopped = false;
  let stopOutbox: (() => void) | null = null;
  const releaseOutbox = () => { stopOutbox?.(); stopOutbox = null; };
  const due = () => next !== null && next <= Date.now();
  const worker = coordinator.register(DELIVERY_QUEUES.founderFallbackNotices, {
    retryMs,
    pausePassiveMaintenance: true,
    run: async signal => {
      if (stopped) return;
      if (!canRun()) {
        // A due deadline becomes an obligation, retried without querying.
        if (due()) { owed = true; next = null; }
        return;
      }
      if (!owed && !due()) return;
      // Cleared before the read, so a hint during the sweep is owed again.
      owed = false;
      next = null;
      stopOutbox ??= subscribeOutbox(wake);
      let result: Awaited<ReturnType<typeof service.sweep>>;
      try {
        result = await service.sweep(signal);
      } catch (error) {
        owed = true;
        throw error;
      }
      if (stopped) { releaseOutbox(); return; }
      next = result.nextDueAt;
      if (!result.awaitingOutbox) releaseOutbox();
    },
    hasPending: async () => !stopped && owed,
    // Settlement of this queue's own outer transactions.
    onSettled: () => { if (!stopped) owed = true; },
    nextRunAt: () => stopped ? null : next,
  });
  function wake() {
    if (stopped) return;
    owed = true;
    worker.wake();
  }
  const unsubscribes = [
    subscribeAllCompanyLiveEvents(event => { if (isFounderFallbackWakeEvent(event)) wake(); }),
    // Lifecycle writers that change agent status without a live event.
    ...[DELIVERY_QUEUES.agentLifecycle, DELIVERY_QUEUES.strandedAgentStatus]
      .map(queue => subscribeDeliveryWork(owner, queue, wake)),
    // Resume a retained obligation as soon as the drain ends. Drain start and
    // an empty resume wake nothing, so an idle probe sees no tracked work.
    subscribeTaskDrainChanges(() => { if (!stopped && canRun() && (owed || due())) worker.wake(); }),
  ];
  return {
    ...worker,
    wake,
    async stop() {
      stopped = true;
      for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
      releaseOutbox();
      await worker.stop();
    },
  };
}
