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
 * Deterministic founder fallback (FAC-597 B1).
 *
 * The agent assigned to a chat endpoint normally owns every ordinary message in
 * its founder DM. When that agent is unavailable, this sweep enqueues short,
 * model-free, clearly labelled notices into the same DM through the native
 * outbox, so retry, UNKNOWN, restart and idempotency stay native. A decision
 * addressed to the founder on another task has no native route into that DM,
 * so it gets its own notice after the bound even while the agent is available.
 * A notice is re-proved at the transport claim and cancelled before any I/O
 * when its condition no longer holds. Disabled unless explicitly configured.
 *
 * The sweep is not a poll. It runs at startup, on wake hints from agent, run,
 * interaction and chat-configuration changes, and at the real deadline when a
 * known condition crosses the bound. With no such deadline it stays idle.
 */

export const FOUNDER_FALLBACK_KEY_PREFIX = "founder-fallback:v1:";
const DEFAULT_BOUND_MINUTES = 20;
const MIN_BOUND_MINUTES = 5;
const MAX_BOUND_MINUTES = 360;
const MAX_ITEMS_PER_SWEEP = 5;
const FAILED_RUN_STATUSES = ["failed", "timed_out"];
const OPEN_PUBLICATION_STATES: (typeof chatPublications.$inferSelect.state)[] = ["pending", "retry", "streaming", "published", "delivery_unknown"];
const IN_FLIGHT_STATES: (typeof chatPublications.$inferSelect.state)[] = ["pending", "retry", "streaming"];
/** Re-arms of one notice cancelled before any provider I/O; later cancellations stay final and visible. */
export const MAX_FOUNDER_FALLBACK_REARMS = 20;

export type FounderFallbackSettings = { enabled: boolean; boundMs: number };

export function founderFallbackSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): FounderFallbackSettings {
  const minutes = Number(env.PAPERCLIP_FOUNDER_FALLBACK_BOUND_MINUTES);
  const bounded = Number.isInteger(minutes)
    ? Math.min(MAX_BOUND_MINUTES, Math.max(MIN_BOUND_MINUTES, minutes))
    : DEFAULT_BOUND_MINUTES;
  return { enabled: env.PAPERCLIP_FOUNDER_FALLBACK_NOTICES === "true", boundMs: bounded * 60_000 };
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
 * `attempt` is absent on the first notice. A notice cancelled before any
 * provider I/O is re-armed as a new row with the next attempt suffix, so each
 * row keeps its own effect identity and the unique key still deduplicates.
 */
export type FounderFallbackKey =
  | { endpointId: string; kind: "agent" | "recovered"; agentId: string; anchor: string; attempt?: number }
  | { endpointId: string; kind: "item"; interactionId: string; attempt?: number };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const KEY_RE = new RegExp(
  `^founder-fallback:v1:(${UUID}):(?:(agent|recovered):(${UUID}):(error\\.(?:${UUID}|none)|paused\\.\\d{1,15}|terminated)|item:(${UUID}))(?::a([1-9]\\d{0,2}))?$`,
);

export function founderFallbackKey(key: FounderFallbackKey): string {
  const base = key.kind === "item"
    ? `${FOUNDER_FALLBACK_KEY_PREFIX}${key.endpointId}:item:${key.interactionId}`
    : `${FOUNDER_FALLBACK_KEY_PREFIX}${key.endpointId}:${key.kind}:${key.agentId}:${key.anchor}`;
  return key.attempt ? `${base}:a${key.attempt}` : base;
}

export function parseFounderFallbackKey(value: string): FounderFallbackKey | null {
  const match = KEY_RE.exec(value);
  if (!match) return null;
  const attempt = match[6] ? { attempt: Number(match[6]) } : {};
  return match[5]
    ? { endpointId: match[1]!, kind: "item", interactionId: match[5], ...attempt }
    : { endpointId: match[1]!, kind: match[2] as "agent" | "recovered", agentId: match[3]!, anchor: match[4]!, ...attempt };
}

function withoutAttempt(key: FounderFallbackKey): FounderFallbackKey {
  const { attempt: _attempt, ...base } = key;
  return base as FounderFallbackKey;
}

function withAttempt(base: string, attempt: number) {
  return attempt ? `${base}:a${attempt}` : base;
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

function utc(date: Date) {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function clip(value: string | null | undefined, max: number) {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function header(agent: Agent) {
  return `Paperclip fallback notice (automatic, not from ${clip(agent.name, 60)}).`;
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

function stateSentence(agent: Agent, state: Unavailability) {
  const name = clip(agent.name, 60);
  if (state.state === "terminated") return `${name} has been terminated.`;
  if (state.state === "paused") return `${name} has been paused since ${utc(state.since)}.`;
  return `${name} has been in error since ${utc(state.since)}${state.runId ? ` (run ${state.runId.slice(0, 8)} failed)` : ""}.`;
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
  if (eligible(state, now, boundMs)) return { kind: "unavailable", state };
  if (toAgent && !state && await escalationMissed(tx, target.agent, interaction, now, boundMs)) return { kind: "missed" };
  // Nothing routes a founder decision on another task into this DM natively,
  // so the agent's availability does not decide whether the founder hears of it.
  if (toFounder && now.getTime() - interaction.createdAt.getTime() >= boundMs) return { kind: "awaiting_founder" };
  return null;
}

/**
 * Counts only items on tasks the founder may read, with the same decision an
 * item notice requires, so the summary reveals no aggregate of hidden tasks.
 */
async function agentNoticeText(tx: Tx, target: Target, state: Unavailability) {
  const perIssue = await tx.select({
    issueId: issueThreadInteractions.issueId,
    escalations: sql<number>`count(*) filter (where ${issueThreadInteractions.addresseeAgentId} = ${target.agent.id})::int`,
    decisions: sql<number>`count(*) filter (where ${issueThreadInteractions.addresseeUserId} = ${target.founderUserId})::int`,
  }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, target.endpoint.companyId),
    eq(issueThreadInteractions.status, "pending"),
    sql`${issueThreadInteractions.issueId} <> ${target.issueId}`,
    sql`(${issueThreadInteractions.addresseeAgentId} = ${target.agent.id} or ${issueThreadInteractions.addresseeUserId} = ${target.founderUserId})`,
  )).groupBy(issueThreadInteractions.issueId).orderBy(asc(issueThreadInteractions.issueId));
  let escalations = 0, decisions = 0;
  for (const row of perIssue) {
    if (!(await founderCanReadIssue(tx, target, row.issueId))) continue;
    escalations += row.escalations;
    decisions += row.decisions;
  }
  const name = clip(target.agent.name, 60);
  return [
    header(target.agent),
    stateSentence(target.agent, state),
    `Waiting on ${name}: ${escalations} escalation(s). Waiting on you: ${decisions} decision(s).`,
    `Until ${name} recovers, Paperclip sends a separate fallback notice here for each one.`,
  ].join("\n");
}

function noticePayload(text: string) {
  return projectSafeChatPublication({ classification: "external", source: "safe_milestone", text });
}

async function itemNoticeText(tx: Tx, target: Target, interaction: Interaction, reason: ItemReason, now: Date) {
  const [issue] = await tx.select({ identifier: issues.identifier, title: issues.title }).from(issues)
    .where(and(eq(issues.id, interaction.issueId), eq(issues.companyId, interaction.companyId)));
  const [creator] = interaction.createdByAgentId
    ? await tx.select({ name: agents.name }).from(agents).where(eq(agents.id, interaction.createdByAgentId))
    : [];
  const name = clip(target.agent.name, 60);
  const toFounder = interaction.addresseeUserId === target.founderUserId;
  const minutes = Math.floor((now.getTime() - interaction.createdAt.getTime()) / 60_000);
  const why = reason.kind === "unavailable"
    ? stateSentence(target.agent, reason.state)
    : reason.kind === "awaiting_founder"
      ? `This decision has waited ${minutes} min for your answer.`
      : `${name} has not started a run on that task since this escalation reached it ${minutes} min ago.`;
  const url = publicChatTaskUrl(interaction.issueId);
  return [
    header(target.agent),
    `Why: ${why}`,
    `${issue?.identifier ?? "Task"} · ${clip(issue?.title, 120)}`,
    `${toFounder ? "Decision waiting for you" : `Escalation to ${name}`}${creator ? ` from ${clip(creator.name, 60)}` : ""}, raised ${utc(interaction.createdAt)}: "${clip(interaction.title ?? interaction.summary ?? interaction.kind, 160)}"`,
    toFounder
      ? `Answer it on that task in Paperclip; a reply in this chat does not resolve it.${url ? ` ${url}` : ""}`
      : `Open the task for the evidence.${url ? ` ${url}` : ""}`,
  ].join("\n");
}

function recoveredText(agent: Agent) {
  return [
    header(agent),
    `${clip(agent.name, 60)} is available again (status ${agent.status}) and resumes founder alerts here. Items it missed stay open on their own tasks.`,
  ].join("\n");
}

export function createFounderFallbackNotices(db: Db, settings: FounderFallbackSettings, clock: () => Date = () => new Date()) {
  /**
   * Re-prove one fallback publication. Called inside the outbox transport
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
    if (!key || key.endpointId !== publication.endpointId) return false;
    const [endpoint] = await tx.select().from(chatEndpoints)
      .where(and(eq(chatEndpoints.id, key.endpointId), eq(chatEndpoints.companyId, publication.companyId)));
    const target = endpoint ? await resolveTarget(tx, endpoint) : null;
    if (!target || target.conversationId !== publication.conversationId || target.issueId !== publication.issueId) return false;
    const now = clock();
    const state = await unavailability(tx, target.agent);
    if (key.kind !== "item") {
      if (key.agentId !== target.agent.id) return false;
      if (key.kind === "recovered") return !state;
      if (!eligible(state, now, settings.boundMs) || state.anchor !== key.anchor) return false;
      // A queued summary is sent only while its counts still match what the
      // founder can read; otherwise it is cancelled before I/O and re-armed.
      if (publication.payload === undefined) return true;
      const sent = (publication.payload as { text?: unknown } | null)?.text;
      return sent === noticePayload(await agentNoticeText(tx, target, state)).text;
    }
    const [interaction] = await tx.select().from(issueThreadInteractions)
      .where(and(eq(issueThreadInteractions.id, key.interactionId), eq(issueThreadInteractions.companyId, publication.companyId)));
    return !!interaction && !!(await itemReason(tx, target, interaction, state, now, settings.boundMs));
  }

  async function insert(target: Target, key: string, text: (tx: Tx) => Promise<string> | string) {
    return db.transaction(async raw => {
      const tx = raw as unknown as Tx;
      const row = {
        companyId: target.endpoint.companyId, endpointId: target.endpoint.id,
        conversationId: target.conversationId, issueId: target.issueId, idempotencyKey: key,
      };
      if (!(await authorizeFounderFallbackPublication(tx, row))) return 0;
      await notifyChatPublicationWork(tx);
      return (await tx.insert(chatPublications).values({
        ...row,
        payload: noticePayload(await text(tx)),
        state: "pending",
      }).onConflictDoNothing().returning({ id: chatPublications.id })).length;
    });
  }

  const outcomeColumns = {
    key: chatPublications.idempotencyKey,
    state: chatPublications.state,
    publishedAt: chatPublications.publishedAt,
    providerMessageId: chatPublications.providerMessageId,
    redactedError: chatPublications.redactedError,
  };

  /**
   * For each base key, the attempt to insert next, or null when a row of that
   * notice is still open, may have reached the founder, failed, or used up its
   * re-arms. Re-arming applies only while every earlier row was cancelled
   * before provider I/O.
   */
  async function nextAttempts(companyId: string, bases: string[]) {
    const plan = new Map<string, number | null>();
    if (!bases.length) return plan;
    const firsts = new Map((await db.select(outcomeColumns).from(chatPublications).where(and(
      eq(chatPublications.companyId, companyId),
      inArray(chatPublications.idempotencyKey, bases),
    ))).map(row => [row.key, row]));
    for (const base of bases) {
      const first = firsts.get(base);
      if (!first) { plan.set(base, 0); continue; }
      if (!founderFallbackDefinitelyUnsent(first)) { plan.set(base, null); continue; }
      const retries = (await db.select(outcomeColumns).from(chatPublications).where(and(
        eq(chatPublications.companyId, companyId),
        like(chatPublications.idempotencyKey, `${base}:a%`),
      ))).flatMap(row => {
        const key = parseFounderFallbackKey(row.key);
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
   * An agent episode stays open until a sweep observes the agent available and
   * queues its recovery notice. A new anchor of the same kind while it is open
   * (another failed retry, a re-pause) is the same unavailability, not a new
   * alert; a change of kind (error to paused, paused to terminated) is. A
   * cancelled or failed notice never reached the founder, so it holds nothing,
   * and a recovery notice cancelled before I/O does not close the episode.
   */
  async function openAgentEpisode(target: Target, state: Unavailability) {
    const [last] = await db.select({ key: chatPublications.idempotencyKey }).from(chatPublications).where(and(
      eq(chatPublications.companyId, target.endpoint.companyId),
      like(chatPublications.idempotencyKey, `${FOUNDER_FALLBACK_KEY_PREFIX}${target.endpoint.id}:agent:${target.agent.id}:%`),
      inArray(chatPublications.state, OPEN_PUBLICATION_STATES),
    )).orderBy(desc(chatPublications.createdAt), desc(chatPublications.id)).limit(1);
    const episode = last ? parseFounderFallbackKey(last.key) : null;
    if (!episode || episode.kind !== "agent" || !episode.anchor.startsWith(state.state)) return false;
    const recovered = founderFallbackKey({ ...withoutAttempt(episode), kind: "recovered" } as FounderFallbackKey);
    return (await nextAttempts(target.endpoint.companyId, [recovered])).get(recovered) !== null;
  }

  async function sweepTarget(target: Target, now: Date) {
    let inserted = 0;
    let awaitingOutbox = false;
    let dueAt: number | null = null;
    const due = (at: number) => { dueAt = dueAt === null ? at : Math.min(dueAt, at); };
    const companyId = target.endpoint.companyId;
    const state = await unavailability(db, target.agent);
    const endpointId = target.endpoint.id;
    const boundAt = state ? state.since.getTime() + settings.boundMs : null;
    if (boundAt !== null && boundAt > now.getTime()) due(boundAt);
    if (eligible(state, now, settings.boundMs)) {
      const key = founderFallbackKey({ endpointId, kind: "agent", agentId: target.agent.id, anchor: state.anchor });
      const attempt = (await nextAttempts(companyId, [key])).get(key);
      if (attempt != null && !(await openAgentEpisode(target, state))) {
        inserted += await insert(target, withAttempt(key, attempt), tx => agentNoticeText(tx, target, state));
      }
    }
    if (!state) {
      // Close only the most recent delivered (or possibly delivered) episode.
      const [last] = await db.select({ key: chatPublications.idempotencyKey, state: chatPublications.state }).from(chatPublications).where(and(
        eq(chatPublications.companyId, companyId),
        like(chatPublications.idempotencyKey, `${FOUNDER_FALLBACK_KEY_PREFIX}${endpointId}:agent:${target.agent.id}:%`),
        inArray(chatPublications.state, [...IN_FLIGHT_STATES, "published", "delivery_unknown"]),
      )).orderBy(desc(chatPublications.createdAt), desc(chatPublications.id)).limit(1);
      const episode = last ? parseFounderFallbackKey(last.key) : null;
      if (last && IN_FLIGHT_STATES.includes(last.state)) {
        // The outbox settles this row: cancelled at its claim, or delivered.
        // Its settlement, not a timer, decides whether a recovery notice follows.
        awaitingOutbox = true;
      } else if (episode && episode.kind === "agent") {
        const key = founderFallbackKey({ ...withoutAttempt(episode), kind: "recovered" } as FounderFallbackKey);
        const attempt = (await nextAttempts(companyId, [key])).get(key);
        if (attempt != null) inserted += await insert(target, withAttempt(key, attempt), () => recoveredText(target.agent));
      }
    }
    const pending = await db.select().from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, companyId),
      eq(issueThreadInteractions.status, "pending"),
      sql`(${issueThreadInteractions.addresseeAgentId} = ${target.agent.id} or ${issueThreadInteractions.addresseeUserId} = ${target.founderUserId})`,
    )).orderBy(asc(issueThreadInteractions.createdAt), asc(issueThreadInteractions.id));
    const keyed = pending.map(interaction => ({ interaction, key: founderFallbackKey({ endpointId, kind: "item", interactionId: interaction.id }) }));
    const plan = await nextAttempts(companyId, keyed.map(item => item.key));
    let items = 0;
    for (const { interaction, key } of keyed) {
      const attempt = plan.get(key);
      if (attempt == null) continue;
      const missedAt = interaction.createdAt.getTime() + settings.boundMs;
      const toFounder = interaction.addresseeUserId === target.founderUserId && interaction.issueId !== target.issueId;
      if ((toFounder || (!state && interaction.addresseeAgentId === target.agent.id)) && missedAt > now.getTime()) due(missedAt);
      if (interaction.createdAt > now) continue;
      if (items >= MAX_ITEMS_PER_SWEEP) { due(now.getTime()); continue; }
      const reason = await itemReason(db, target, interaction, state, now, settings.boundMs);
      if (!reason) continue;
      const count = await insert(target, withAttempt(key, attempt), tx => itemNoticeText(tx, target, interaction, reason, now));
      items += count;
      inserted += count;
    }
    return { inserted, awaitingOutbox, dueAt: dueAt as number | null };
  }

  /**
   * `nextDueAt` is the earliest real deadline of a known condition, or null.
   * `awaitingOutbox` means a recovered agent's notice is still in flight, so
   * the outcome of that outbox row decides the next step.
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

  return { authorizeFounderFallbackPublication, sweep };
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
