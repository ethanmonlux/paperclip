import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents, chatConversations, chatDeliveries, chatEndpoints, chatExternalPrincipals, chatIdentityLinks,
  chatPublications, companies, companyMemberships, createDb, heartbeatRuns, issueAccessGrants, issueThreadInteractions, issues,
  toolApplications, toolConnections,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  FOUNDER_FALLBACK_KEY_PREFIX, FOUNDER_REMINDER_INTERVAL_MS, MAX_FOUNDER_FALLBACK_REARMS, MAX_FOUNDER_REMINDERS,
  createFounderFallbackNotices, founderAskHints, founderFallbackDefinitelyUnsent, founderFallbackKey,
  founderFallbackSettingsFromEnv, founderQuietHoursEnd, inFounderQuietHours, isFounderFallbackPublication,
  isFounderFallbackWakeEvent, parseFounderFallbackKey, registerFounderFallbackNoticeWork, type FounderFallbackKey,
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
    const five = Array.from({ length: 5 }, () => randomUUID());
    const keys: FounderFallbackKey[] = [
      { endpointId, kind: "asks", interactionIds: [interactionId] },
      { endpointId, kind: "asks", interactionIds: five, attempt: 3 },
      { endpointId, kind: "done", interactionId },
      { endpointId, kind: "done", interactionId, attempt: 1 },
      { endpointId, kind: "agent", agentId, anchor: `error.${runId}` },
      { endpointId, kind: "agent", agentId, anchor: "error.none" },
      { endpointId, kind: "agent", agentId, anchor: "paused.1793732233969" },
      { endpointId, kind: "recovered", agentId, anchor: "terminated" },
      { endpointId, kind: "item", interactionId },
      { endpointId, kind: "item", interactionId, attempt: 1 },
      { endpointId, kind: "agent", agentId, anchor: "terminated", attempt: 20 },
    ];
    for (const key of keys) {
      const value = founderFallbackKey(key);
      expect(value.startsWith(FOUNDER_FALLBACK_KEY_PREFIX)).toBe(true);
      expect(isFounderFallbackPublication({ idempotencyKey: value })).toBe(true);
      expect(parseFounderFallbackKey(value)).toEqual(key);
    }
    for (const value of [
      `${FOUNDER_FALLBACK_KEY_PREFIX}${endpointId}:agent:${agentId}:error.x`,
      `${FOUNDER_FALLBACK_KEY_PREFIX}${endpointId}:item:${interactionId}:extra`,
      `${FOUNDER_FALLBACK_KEY_PREFIX}${endpointId}:item:${interactionId}:a0`,
      `${FOUNDER_FALLBACK_KEY_PREFIX}${endpointId}:asks:${interactionId}+${interactionId}`,
      `${FOUNDER_FALLBACK_KEY_PREFIX}${endpointId}:asks:${[...five, interactionId].join("+")}`,
      `${FOUNDER_FALLBACK_KEY_PREFIX}${endpointId}:asks:`,
      `${FOUNDER_FALLBACK_KEY_PREFIX}${endpointId}:done:${interactionId}+${runId}`,
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

  it("reads effort and place only when the card states them", () => {
    expect(founderAskHints("Attach the .riv file at the PC, about 15 minutes")).toEqual({ estimate: "~15 min", where: "PC" });
    expect(founderAskHints("Walk through E2E setup (45-minute, desktop)")).toEqual({ estimate: "~45 min", where: "PC" });
    expect(founderAskHints("Approve publish from your phone, ~2 min")).toEqual({ estimate: "~2 min", where: "phone" });
    expect(founderAskHints("Review the plan (1 hour)")).toEqual({ estimate: "~1 h", where: null });
    expect(founderAskHints("Approve public branch/PR authority")).toEqual({ estimate: null, where: null });
  });

  it("keeps quiet hours from 23:00 to 07:00 Mountain, across the DST change", () => {
    // MST (UTC-7) after 2026-11-01; MDT (UTC-6) before.
    expect(inFounderQuietHours(new Date("2026-11-10T05:59:00Z"))).toBe(false); // 22:59 MST
    expect(inFounderQuietHours(new Date("2026-11-10T06:00:00Z"))).toBe(true); // 23:00 MST
    expect(inFounderQuietHours(new Date("2026-11-10T13:59:00Z"))).toBe(true); // 06:59 MST
    expect(inFounderQuietHours(new Date("2026-11-10T14:00:00Z"))).toBe(false); // 07:00 MST
    expect(inFounderQuietHours(new Date("2026-10-20T12:30:00Z"))).toBe(true); // 06:30 MDT
    expect(inFounderQuietHours(new Date("2026-10-20T13:00:00Z"))).toBe(false); // 07:00 MDT
    expect(founderQuietHoursEnd(new Date("2026-11-10T06:10:00Z"))).toBe(Date.parse("2026-11-10T14:00:00Z"));
    expect(founderQuietHoursEnd(new Date("2026-11-01T06:30:00Z"))).toBe(Date.parse("2026-11-01T14:00:00Z")); // DST ends that night
    expect(founderQuietHoursEnd(new Date("2026-11-10T18:00:00Z"))).toBe(Date.parse("2026-11-10T18:00:00Z"));
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
  // A run's own https PAPERCLIP_API_URL would otherwise add card links; tests opt in.
  beforeEach(() => { vi.stubEnv("PAPERCLIP_API_URL", ""); });
  afterEach(async () => {
    for (const table of [chatPublications, chatDeliveries, chatIdentityLinks, chatExternalPrincipals, chatConversations,
      chatEndpoints, toolConnections, toolApplications, issueThreadInteractions, heartbeatRuns, issues, companyMemberships,
      agents, companies]) await db.delete(table);
  });
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  // 11:00 MST, outside founder quiet hours.
  const start = new Date("2026-11-03T18:00:00.000Z");
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
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  async function addSender(input: { companyId: string; endpointId: string; conversationId: string; principalId: string; userId: string }) {
    await db.insert(chatExternalPrincipals).values({ id: input.principalId, companyId: input.companyId, provider: "discord",
      providerAccountId: "bot", externalId: input.principalId });
    await db.insert(chatIdentityLinks).values({ companyId: input.companyId, endpointId: input.endpointId, principalId: input.principalId,
      paperclipUserId: input.userId, status: "linked", confirmedAt: start });
    await db.insert(chatDeliveries).values({ companyId: input.companyId, endpointId: input.endpointId, conversationId: input.conversationId,
      principalId: input.principalId, providerEventId: randomUUID(), deduplicationKey: randomUUID(), eventKind: "direct_message",
      normalizedEvent: {}, state: "processed" });
  }

  async function failAgent(f: Fixture, finishedAt: Date) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "failed",
      createdAt: finishedAt, startedAt: finishedAt, finishedAt }).returning();
    await db.update(agents).set({ status: "error", updatedAt: finishedAt }).where(eq(agents.id, f.agentId));
    return run!;
  }

  async function interaction(f: Fixture, values: Partial<typeof issueThreadInteractions.$inferInsert>) {
    const [row] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.otherIssueId,
      kind: "request_confirmation", payload: { version: 1, prompt: "Approve?" } as never, title: "Approve the canary",
      createdByAgentId: f.workerId, createdAt: start, ...values }).returning();
    return row!;
  }

  const resolve = (id: string, status = "accepted") =>
    db.update(issueThreadInteractions).set({ status, updatedAt: now }).where(eq(issueThreadInteractions.id, id));
  const asksKey = (f: Fixture, ids: string[], attempt?: number) =>
    founderFallbackKey({ endpointId: f.endpointId, kind: "asks", interactionIds: ids, ...(attempt ? { attempt } : {}) });
  const doneKey = (f: Fixture, id: string) => founderFallbackKey({ endpointId: f.endpointId, kind: "done", interactionId: id });
  const rows = (f: { companyId: string }) => db.select().from(chatPublications)
    .where(and(eq(chatPublications.companyId, f.companyId), like(chatPublications.idempotencyKey, `${FOUNDER_FALLBACK_KEY_PREFIX}%`)))
    .orderBy(asc(chatPublications.createdAt), asc(chatPublications.idempotencyKey));
  const text = (row: typeof chatPublications.$inferSelect) => String((row.payload as { text?: unknown }).text ?? "");
  /** What the outbox does once it delivers every queued founder row. */
  const deliver = (f: { companyId: string }) => db.update(chatPublications).set({ state: "published", publishedAt: now })
    .where(and(eq(chatPublications.companyId, f.companyId), like(chatPublications.idempotencyKey, `${FOUNDER_FALLBACK_KEY_PREFIX}%`),
      eq(chatPublications.state, "pending")));
  const kinds = async (f: { companyId: string }) => (await rows(f)).map(row => row.idempotencyKey.split(":")[3]);

  it("replays the Nov 9 drain pause, three founder cards and their resolution as one-line asks and retractions (STA-219)", async () => {
    // The live install's shape: no explicit public URL, only its https API origin.
    for (const name of ["PAPERCLIP_AUTH_PUBLIC_BASE_URL", "BETTER_AUTH_URL", "BETTER_AUTH_BASE_URL",
      "PAPERCLIP_PUBLIC_URL", "PAPERCLIP_MANAGED_RUNTIME_PUBLIC_URL"]) vi.stubEnv(name, "");
    vi.stubEnv("PAPERCLIP_API_URL", "https://ethan-desktop.tail5192df.ts.net");
    try {
      const f = await fixture();
      await db.delete(issueThreadInteractions);
      await db.update(companies).set({ issuePrefix: "STA" }).where(eq(companies.id, f.companyId));
      const card = async (identifier: string, title: string, summary: string, createdAt: string) => {
        const issueId = randomUUID();
        await db.insert(issues).values({ id: issueId, companyId: f.companyId, title: `${identifier} task`, identifier, priority: "high" });
        return interaction(f, { issueId, addresseeUserId: f.founderUserId, title, summary, createdAt: new Date(createdAt) });
      };
      const sweepAt = async (iso: string) => { now = new Date(iso); return f.service.sweep(); };
      const sent: string[] = [];
      const flush = async () => {
        const queued = (await rows(f)).filter(row => row.state === "pending");
        for (const row of queued) expect(await f.service.authorizeFounderFallbackPublication(db, row)).toBe(true);
        sent.push(...queued.map(text));
        await deliver(f);
      };

      const publish = await card("STA-176", "Approve publishing the beta build", "From your phone, about 2 minutes.", "2026-11-09T11:49:00Z");
      const e2e = await card("STA-162", "Finish the E2E test account setup", "At the PC, about 45 minutes.", "2026-11-09T14:30:00Z");
      // The drain pauses Master Builder: internal state, never an alert.
      await db.update(agents).set({ status: "paused", pausedAt: new Date("2026-11-09T15:58:00Z") }).where(eq(agents.id, f.agentId));
      expect(await sweepAt("2026-11-09T15:58:00Z")).toMatchObject({ inserted: 1 });
      await flush();
      expect(await sweepAt("2026-11-09T16:30:00Z")).toMatchObject({ inserted: 0 });
      const riv = await card("STA-198", "Attach the approved .riv file", "At the PC, ~15 min.", "2026-11-09T16:40:00Z");
      expect(await sweepAt("2026-11-09T17:00:00Z")).toMatchObject({ inserted: 1 });
      await flush();
      await db.update(agents).set({ status: "idle", pausedAt: null }).where(eq(agents.id, f.agentId));
      expect(await sweepAt("2026-11-09T17:30:00Z")).toMatchObject({ inserted: 0 });

      // Each card resolves on its own task: one retraction each, then silence.
      now = new Date("2026-11-09T19:13:00Z");
      await resolve(riv.id);
      expect(await sweepAt("2026-11-09T19:13:00Z")).toMatchObject({ inserted: 1 });
      await flush();
      now = new Date("2026-11-09T19:40:00Z");
      await resolve(e2e.id);
      now = new Date("2026-11-09T19:41:00Z");
      await resolve(publish.id);
      expect(await sweepAt("2026-11-09T19:41:00Z")).toMatchObject({ inserted: 2 });
      await flush();
      expect(await sweepAt("2026-11-09T23:59:00Z")).toMatchObject({ inserted: 0, nextDueAt: null, awaitingOutbox: false });

      // The exact Discord payloads, in order. The last two retractions come
      // from one sweep and share its transaction time, so their order is not
      // meaningful and the pair is compared as a set.
      expect([...sent.slice(0, 3), ...sent.slice(3).sort()]).toEqual([
        "[Needs you] Approve publishing the beta build · ~2 min · phone · waiting 4h (since 4:49 AM MST)\n"
          + "https://ethan-desktop.tail5192df.ts.net/STA/issues/STA-176\n\n"
          + "[Needs you] Finish the E2E test account setup · ~45 min · PC · waiting 1h (since 7:30 AM MST)\n"
          + "https://ethan-desktop.tail5192df.ts.net/STA/issues/STA-162",
        "[Needs you] Attach the approved .riv file · ~15 min · PC · waiting 20 min (since 9:40 AM MST)\n"
          + "https://ethan-desktop.tail5192df.ts.net/STA/issues/STA-198",
        "[Done] No action needed: Attach the approved .riv file (STA-198)",
        "[Done] No action needed: Approve publishing the beta build (STA-176)",
        "[Done] No action needed: Finish the E2E test account setup (STA-162)",
      ]);
      for (const message of sent) {
        expect(message).not.toMatch(/Master Builder|paused|available again|fallback|automatic|UTC/i);
      }
      expect(await kinds(f)).toEqual(["asks", "asks", "done", "done", "done"]);
      // The receipt shows the delivered ask carried the tappable card link.
      expect(await f.service.interactionReceipt(f.companyId, riv.issueId, riv.id)).toMatchObject({
        cardUrl: "https://ethan-desktop.tail5192df.ts.net/STA/issues/STA-198",
        publications: [{ idempotencyKey: expect.stringContaining(":asks:"), state: "published", linked: true },
          { idempotencyKey: expect.stringContaining(":done:"), state: "published", linked: false }],
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reports the original founder decision and its exact outbox effect", async () => {
    const f = await fixture();
    const decision = await interaction(f, { addresseeUserId: f.founderUserId });
    at(21);
    const before = await f.service.interactionReceipt(f.companyId, f.otherIssueId, decision.id);
    expect(before).toMatchObject({ configured: true, interactionStatus: "pending", publications: [],
      targets: [{ endpointId: f.endpointId, conversationId: f.conversationId, eligible: true, reason: "awaiting_founder" }] });
    expect((await f.service.sweep()).inserted).toBe(1);
    const after = await f.service.interactionReceipt(f.companyId, f.otherIssueId, decision.id);
    expect(after?.publications).toMatchObject([{ endpointId: f.endpointId, conversationId: f.conversationId,
      idempotencyKey: asksKey(f, [decision.id]), state: "pending" }]);
    // No public URL and no https API origin: the ask goes out without a link, and the receipt says so.
    expect(after).toMatchObject({ cardUrl: null, publications: [{ linked: false }] });
    vi.stubEnv("PAPERCLIP_API_URL", "http://127.0.0.1:3100");
    expect((await f.service.interactionReceipt(f.companyId, f.otherIssueId, decision.id))?.cardUrl).toBeNull();
    vi.stubEnv("PAPERCLIP_API_URL", "");
    expect(after?.publications[0]).not.toHaveProperty("providerUrl");
    expect(after?.publications[0]).not.toHaveProperty("redactedError");
    expect(await f.service.interactionReceipt(f.companyId, f.dmIssueId, decision.id)).toBeNull();
    // A retraction belongs to the same receipt.
    await deliver(f);
    await resolve(decision.id);
    expect((await f.service.sweep()).inserted).toBe(1);
    expect((await f.service.interactionReceipt(f.companyId, f.otherIssueId, decision.id))?.publications.map(row => row.idempotencyKey))
      .toEqual([asksKey(f, [decision.id]), doneKey(f, decision.id)]);
    const escalation = await interaction(f, { addresseeAgentId: f.agentId });
    expect((await f.service.interactionReceipt(f.companyId, f.otherIssueId, escalation.id))?.targets)
      .toMatchObject([{ endpointId: f.endpointId, eligible: true, reason: "missed" }]);
  });

  it("never alerts agent availability: error, pause, termination and recovery send nothing", async () => {
    const f = await fixture();
    await failAgent(f, start);
    at(30);
    expect(await f.service.sweep()).toMatchObject({ targets: 1, inserted: 0, nextDueAt: null });
    await db.update(agents).set({ status: "paused", pausedAt: now }).where(eq(agents.id, f.agentId));
    at(60);
    expect((await f.service.sweep()).inserted).toBe(0);
    await db.update(agents).set({ status: "idle", pausedAt: null }).where(eq(agents.id, f.agentId));
    at(70);
    expect((await f.service.sweep()).inserted).toBe(0);
    await db.update(agents).set({ status: "terminated", updatedAt: now }).where(eq(agents.id, f.agentId));
    at(100);
    expect((await f.service.sweep()).inserted).toBe(0);
    expect(await rows(f)).toEqual([]);
  });

  it("shows the founder the same ask whether the DM agent is available or paused", async () => {
    const texts: string[] = [];
    for (const paused of [false, true]) {
      const f = await fixture();
      await interaction(f, { addresseeUserId: f.founderUserId, title: "Approve the canary" });
      if (paused) await db.update(agents).set({ status: "paused", pausedAt: start }).where(eq(agents.id, f.agentId));
      at(25);
      expect((await f.service.sweep()).inserted).toBe(1);
      texts.push(text((await rows(f))[0]!));
      for (const table of [chatPublications, chatDeliveries, chatIdentityLinks, chatExternalPrincipals, chatConversations,
        chatEndpoints, toolConnections, toolApplications, issueThreadInteractions, heartbeatRuns, issues, companyMemberships,
        agents, companies]) await db.delete(table);
    }
    expect(texts[0]).toBe("[Needs you] Approve the canary · waiting 25 min (since 11:00 AM MST)\nF-2");
    expect(texts[1]).toBe(texts[0]);
  });

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

  it("lists every waiting item in one message with one link each, deduplicated", async () => {
    const f = await fixture();
    const escalation = await interaction(f, { addresseeAgentId: f.agentId, title: "Coordinator needs Master Builder" });
    const decision = await interaction(f, { addresseeUserId: f.founderUserId, title: "Founder approval",
      createdAt: new Date(start.getTime() + MINUTE) });
    await interaction(f, { addresseeUserId: f.founderUserId, issueId: f.dmIssueId, title: "Native DM card" });
    await interaction(f, { addresseeAgentId: f.workerId, title: "Not for the founder" });
    await failAgent(f, start);
    at(21);
    expect(await f.service.sweep()).toMatchObject({ targets: 1, inserted: 1 });
    const [notice, ...rest] = await rows(f);
    expect(rest).toEqual([]);
    expect(notice).toMatchObject({ idempotencyKey: asksKey(f, [escalation.id, decision.id]),
      conversationId: f.conversationId, issueId: f.dmIssueId, endpointId: f.endpointId, state: "pending" });
    expect(text(notice!)).toBe([
      "[Needs you] Stuck, needs a board action: Coordinator needs Master Builder · waiting 21 min (since 11:00 AM MST)",
      "F-2",
      "",
      "[Needs you] Founder approval · waiting 20 min (since 11:01 AM MST)",
      "F-2",
    ].join("\n"));
    at(40);
    expect((await f.service.sweep()).inserted).toBe(0);
    expect(await rows(f)).toHaveLength(1);
  });

  it("puts critical items first and links each card by its company route", async () => {
    vi.stubEnv("PAPERCLIP_AUTH_PUBLIC_BASE_URL", "https://board.example.com");
    try {
      const f = await fixture();
      const criticalIssueId = randomUUID();
      await db.insert(issues).values({ id: criticalIssueId, companyId: f.companyId, title: "Live outage", identifier: "F-9", priority: "critical" });
      await interaction(f, { addresseeUserId: f.founderUserId, title: "Older ordinary card" });
      await interaction(f, { issueId: criticalIssueId, addresseeUserId: f.founderUserId, title: "Approve the rollback",
        createdAt: new Date(start.getTime() + MINUTE) });
      at(30);
      await f.service.sweep();
      const [company] = await db.select().from(companies).where(eq(companies.id, f.companyId));
      const lines = text((await rows(f))[0]!).split("\n");
      expect(lines[0]).toContain("Approve the rollback");
      expect(lines[1]).toBe(`https://board.example.com/${company!.issuePrefix}/issues/F-9`);
      expect(lines[3]).toContain("Older ordinary card");
      expect(lines[4]).toBe(`https://board.example.com/${company!.issuePrefix}/issues/F-2`);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("re-proves each notice at the transport claim and fails closed when its condition is gone", async () => {
    const f = await fixture();
    const decision = await interaction(f, { addresseeUserId: f.founderUserId });
    at(21);
    await f.service.sweep();
    const [ask] = await rows(f);
    expect(await f.service.authorizeFounderFallbackPublication(db, ask!)).toBe(true);

    // A disabled service never authorizes, even for an existing row.
    const disabled = createFounderFallbackNotices(db, { enabled: false, boundMs: BOUND }, () => now);
    expect(await disabled.authorizeFounderFallbackPublication(db, ask!)).toBe(false);
    expect(await disabled.sweep()).toEqual({ targets: 0, inserted: 0, nextDueAt: null, awaitingOutbox: false });
    // A key moved to another conversation, issue or endpoint does not authorize.
    expect(await f.service.authorizeFounderFallbackPublication(db, { ...ask!, conversationId: randomUUID() })).toBe(false);
    expect(await f.service.authorizeFounderFallbackPublication(db, { ...ask!, issueId: f.otherIssueId })).toBe(false);
    expect(await f.service.authorizeFounderFallbackPublication(db, { ...ask!, endpointId: randomUUID() })).toBe(false);
    // Retired formats never authorize, so queued availability notices are cancelled before I/O.
    for (const key of [
      founderFallbackKey({ endpointId: f.endpointId, kind: "agent", agentId: f.agentId, anchor: "error.none" }),
      founderFallbackKey({ endpointId: f.endpointId, kind: "recovered", agentId: f.agentId, anchor: "error.none" }),
      founderFallbackKey({ endpointId: f.endpointId, kind: "item", interactionId: decision.id }),
    ]) expect(await f.service.authorizeFounderFallbackPublication(db, { ...ask!, idempotencyKey: key })).toBe(false);

    await db.update(chatEndpoints).set({ status: "paused" }).where(eq(chatEndpoints.id, f.endpointId));
    expect(await f.service.authorizeFounderFallbackPublication(db, ask!)).toBe(false);
    await db.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, f.endpointId));

    // Resolved before delivery: the ask is cancelled and nothing is retracted.
    await resolve(decision.id);
    expect(await f.service.authorizeFounderFallbackPublication(db, ask!)).toBe(false);
    const done = { ...ask!, idempotencyKey: doneKey(f, decision.id) };
    expect(await f.service.authorizeFounderFallbackPublication(db, done)).toBe(false);
    await db.update(chatPublications).set({ state: "cancelled", redactedError: "Notice no longer applies" }).where(eq(chatPublications.id, ask!.id));
    expect((await f.service.sweep()).inserted).toBe(0);
    // Once an ask may have reached the founder, the resolution retracts it.
    await db.update(chatPublications).set({ state: "delivery_unknown" }).where(eq(chatPublications.id, ask!.id));
    expect(await f.service.authorizeFounderFallbackPublication(db, done)).toBe(true);
    await db.update(issueThreadInteractions).set({ status: "pending" }).where(eq(issueThreadInteractions.id, decision.id));
    expect(await f.service.authorizeFounderFallbackPublication(db, done)).toBe(false);
  });

  it("cancels a whole batch when one item resolves before delivery and lists the rest again", async () => {
    const f = await fixture();
    const first = await interaction(f, { addresseeUserId: f.founderUserId, title: "First" });
    const second = await interaction(f, { addresseeUserId: f.founderUserId, title: "Second", createdAt: new Date(start.getTime() + 1000) });
    at(21);
    await f.service.sweep();
    const [batch] = await rows(f);
    expect(batch!.idempotencyKey).toBe(asksKey(f, [first.id, second.id]));
    expect(await f.service.sweep()).toMatchObject({ inserted: 0, awaitingOutbox: true });
    await resolve(first.id);
    expect(await f.service.authorizeFounderFallbackPublication(db, batch!)).toBe(false);
    await db.update(chatPublications).set({ state: "cancelled", redactedError: "Notice no longer applies" }).where(eq(chatPublications.id, batch!.id));
    at(22);
    expect(await f.service.sweep()).toMatchObject({ inserted: 1 });
    const relisted = (await rows(f)).at(-1)!;
    expect(relisted.idempotencyKey).toBe(asksKey(f, [second.id], 1));
    expect(text(relisted)).toContain("Second");
    expect(text(relisted)).not.toContain("First");
    // The resolved item never reached the founder, so it gets no retraction.
    await deliver(f);
    expect((await f.service.sweep()).inserted).toBe(0);
    expect(await kinds(f)).toEqual(["asks", "asks"]);
  });

  it("reminds a still-pending item at most every four hours, a bounded number of times", async () => {
    const f = await fixture();
    const decision = await interaction(f, { addresseeUserId: f.founderUserId, title: "Approve the canary" });
    at(20);
    await f.service.sweep();
    await deliver(f);
    const firstAt = now.getTime();
    at(21);
    expect(await f.service.sweep()).toMatchObject({ inserted: 0, nextDueAt: firstAt + FOUNDER_REMINDER_INTERVAL_MS });
    now = new Date(firstAt + FOUNDER_REMINDER_INTERVAL_MS - 1);
    expect((await f.service.sweep()).inserted).toBe(0);
    now = new Date(firstAt + FOUNDER_REMINDER_INTERVAL_MS);
    expect((await f.service.sweep()).inserted).toBe(1);
    const reminder = (await rows(f)).at(-1)!;
    expect(reminder.idempotencyKey).toBe(asksKey(f, [decision.id], 1));
    expect(text(reminder)).toBe("[Still needs you] Approve the canary · waiting 4h (since 11:00 AM MST)\nF-2");
    await deliver(f);
    for (let index = 1; index < MAX_FOUNDER_REMINDERS; index += 1) {
      now = new Date(now.getTime() + FOUNDER_REMINDER_INTERVAL_MS);
      // A reminder that would land in quiet hours waits for the morning.
      if (inFounderQuietHours(now)) now = new Date(founderQuietHoursEnd(now));
      expect((await f.service.sweep()).inserted).toBe(1);
      await deliver(f);
    }
    now = new Date(now.getTime() + 3 * FOUNDER_REMINDER_INTERVAL_MS);
    if (inFounderQuietHours(now)) now = new Date(founderQuietHoursEnd(now));
    expect(await f.service.sweep()).toMatchObject({ inserted: 0, nextDueAt: null });
    expect(await rows(f)).toHaveLength(1 + MAX_FOUNDER_REMINDERS);
  });

  it("holds ordinary asks and retractions during quiet hours, but not a critical item", async () => {
    const f = await fixture();
    const criticalIssueId = randomUUID();
    await db.insert(issues).values({ id: criticalIssueId, companyId: f.companyId, title: "Live outage", identifier: "F-9", priority: "critical" });
    // 23:30 MST.
    const late = new Date("2026-11-04T06:30:00.000Z");
    const ordinary = await interaction(f, { addresseeUserId: f.founderUserId, title: "Ordinary card", createdAt: new Date(late.getTime() - 30 * MINUTE) });
    const critical = await interaction(f, { issueId: criticalIssueId, addresseeUserId: f.founderUserId, title: "Approve the rollback",
      createdAt: new Date(late.getTime() - 30 * MINUTE) });
    now = late;
    const morning = Date.parse("2026-11-04T14:00:00.000Z");
    expect(await f.service.sweep()).toMatchObject({ inserted: 1, nextDueAt: morning });
    expect((await rows(f)).map(row => row.idempotencyKey)).toEqual([asksKey(f, [critical.id])]);
    await deliver(f);
    await resolve(critical.id);
    expect(await f.service.sweep()).toMatchObject({ inserted: 0, nextDueAt: morning });
    now = new Date(morning);
    expect((await f.service.sweep()).inserted).toBe(2);
    expect((await rows(f)).slice(1).map(row => row.idempotencyKey).sort())
      .toEqual([asksKey(f, [ordinary.id]), doneKey(f, critical.id)].sort());
  });

  it("re-checks quiet hours at the transport claim, so a row queued at 22:59 waits for 07:00 (STA-273)", async () => {
    const f = await fixture();
    const criticalIssueId = randomUUID();
    await db.insert(issues).values({ id: criticalIssueId, companyId: f.companyId, title: "Live outage", identifier: "F-9", priority: "critical" });
    // 22:59 MST: still outside quiet hours.
    const evening = new Date("2026-11-04T05:59:00.000Z");
    const ordinary = await interaction(f, { addresseeUserId: f.founderUserId, title: "Ordinary card", createdAt: new Date(evening.getTime() - 30 * MINUTE) });
    const resolved = await interaction(f, { addresseeUserId: f.founderUserId, title: "Answered card", createdAt: new Date(evening.getTime() - 60 * MINUTE) });
    const critical = await interaction(f, { issueId: criticalIssueId, addresseeUserId: f.founderUserId, title: "Approve the rollback",
      createdAt: new Date(evening.getTime() - 30 * MINUTE) });
    // The answered card was already alerted and delivered; its [Done] is queued at 22:59.
    now = new Date(evening.getTime() - 35 * MINUTE);
    expect((await f.service.sweep()).inserted).toBe(1);
    await deliver(f);
    await resolve(resolved.id);
    now = evening;
    expect((await f.service.sweep()).inserted).toBe(2);
    const queued = (await rows(f)).filter(row => row.state === "pending");
    const ask = queued.find(row => row.idempotencyKey === asksKey(f, [critical.id, ordinary.id]));
    const done = queued.find(row => row.idempotencyKey === doneKey(f, resolved.id));
    expect(ask && done).toBeTruthy();
    expect(await f.service.authorizeFounderFallbackPublication(db, ask!)).toBe(true);
    expect(await f.service.authorizeFounderFallbackPublication(db, done!)).toBe(true);

    // Claimed at 23:01 MST: a batch with any ordinary item and every [Done] are
    // cancelled before I/O; an all-critical batch still goes out.
    now = new Date("2026-11-04T06:01:00.000Z");
    expect(await f.service.authorizeFounderFallbackPublication(db, ask!)).toBe(false);
    expect(await f.service.authorizeFounderFallbackPublication(db, done!)).toBe(false);
    await db.update(chatPublications).set({ state: "cancelled", redactedError: "Notice no longer applies" })
      .where(inArray(chatPublications.id, [ask!.id, done!.id]));
    const morning = Date.parse("2026-11-04T14:00:00.000Z");
    expect(await f.service.sweep()).toMatchObject({ inserted: 1, nextDueAt: morning });
    const [criticalOnly] = (await rows(f)).filter(row => row.state === "pending");
    expect(criticalOnly!.idempotencyKey).toBe(asksKey(f, [critical.id], 1));
    expect(await f.service.authorizeFounderFallbackPublication(db, criticalOnly!)).toBe(true);
    await deliver(f);

    // At 07:00 the ordinary ask is listed again, beside the critical item's
    // reminder (four hours after 23:01), and the retraction goes out.
    now = new Date(morning);
    expect((await f.service.sweep()).inserted).toBe(2);
    const relisted = (await rows(f)).filter(row => row.state === "pending");
    expect(relisted.map(row => row.idempotencyKey).sort())
      .toEqual([asksKey(f, [critical.id, ordinary.id], 2), `${doneKey(f, resolved.id)}:a1`].sort());
    for (const row of relisted) expect(await f.service.authorizeFounderFallbackPublication(db, row)).toBe(true);
  });

  it("fails closed unless every DM sender links to the same active company owner", async () => {
    const f = await fixture();
    await interaction(f, { addresseeUserId: f.founderUserId });
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
    expect(notice!.idempotencyKey).toBe(asksKey(f, [unread.id]));
    expect(notice!.idempotencyKey).not.toContain(pickedUp.id);
    expect(text(notice!)).toBe("[Needs you] Stuck, needs a board action: Unread escalation · waiting 29 min (since 11:01 AM MST)\nF-2");

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
    expect((await rows(f)).map(row => row.idempotencyKey)).toEqual([asksKey(f, [escalation.id])]);

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

  it("alerts once for a founder decision on another task while the DM agent is available (STA-176)", async () => {
    const f = await fixture();
    // Another agent asks the founder directly; the DM agent never touches that task.
    const decision = await interaction(f, { addresseeUserId: f.founderUserId, title: "Approve public branch/PR authority" });
    at(19);
    expect(await f.service.sweep()).toMatchObject({ targets: 1, inserted: 0, nextDueAt: start.getTime() + BOUND });
    at(20);
    expect((await f.service.sweep()).inserted).toBe(1);
    const [notice, ...rest] = await rows(f);
    expect(rest).toEqual([]);
    expect(notice).toMatchObject({ idempotencyKey: asksKey(f, [decision.id]),
      conversationId: f.conversationId, issueId: f.dmIssueId, endpointId: f.endpointId, state: "pending" });
    expect(text(notice!)).toBe("[Needs you] Approve public branch/PR authority · waiting 20 min (since 11:00 AM MST)\nF-2");
    expect(await f.service.authorizeFounderFallbackPublication(db, notice!)).toBe(true);

    // The DM agent running on the task does not silence a decision only the founder can make.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId: f.otherIssueId, status: "running",
      createdAt: now, startedAt: now });
    expect(await f.service.authorizeFounderFallbackPublication(db, notice!)).toBe(true);
    at(60);
    expect((await f.service.sweep()).inserted).toBe(0);
    const restarted = createFounderFallbackNotices(db, { enabled: true, boundMs: BOUND }, () => now);
    expect((await restarted.sweep()).inserted).toBe(0);
    expect(await rows(f)).toHaveLength(1);

    // An answer on the original task makes a queued notice fail closed before any I/O.
    await resolve(decision.id);
    expect(await f.service.authorizeFounderFallbackPublication(db, notice!)).toBe(false);
  });

  it("does not alert a founder decision addressed to someone else or on a task the founder cannot read", async () => {
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    try {
      const f = await fixture();
      const hiddenIssueId = randomUUID();
      await db.insert(issues).values({ id: hiddenIssueId, companyId: f.companyId, title: "Hidden private task", identifier: "F-5", visibility: "private" });
      await interaction(f, { addresseeUserId: `someone-${randomUUID()}`, title: "Not the founder" });
      await interaction(f, { issueId: hiddenIssueId, addresseeUserId: f.founderUserId, title: "Hidden decision" });
      at(30);
      expect((await f.service.sweep()).inserted).toBe(0);
      expect(await rows(f)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps a founder DM whose task closed as the target, unless a task control ended it", async () => {
    const f = await fixture();
    // The DM's own task was cancelled; its conversation is completed but still deliverable.
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.dmIssueId));
    await db.update(chatConversations).set({ state: "completed" }).where(eq(chatConversations.id, f.conversationId));
    const decision = await interaction(f, { addresseeUserId: f.founderUserId });
    at(20);
    expect(await f.service.sweep()).toMatchObject({ targets: 1, inserted: 1 });
    const [notice] = await rows(f);
    expect(notice).toMatchObject({ conversationId: f.conversationId, idempotencyKey: asksKey(f, [decision.id]) });
    expect(await f.service.authorizeFounderFallbackPublication(db, notice!)).toBe(true);

    // An open DM of the same founder is preferred over the completed one.
    const openIssueId = randomUUID(), openConversationId = randomUUID();
    await db.insert(issues).values({ id: openIssueId, companyId: f.companyId, title: "New founder DM", assigneeAgentId: f.agentId, identifier: "F-6" });
    await db.insert(chatConversations).values({ id: openConversationId, companyId: f.companyId, endpointId: f.endpointId, issueId: openIssueId,
      externalConversationId: "dm-1", externalLabel: "Founder DM", isDirectMessage: true, state: "active", sessionGeneration: 2, lastActivityAt: start });
    await addSender({ companyId: f.companyId, endpointId: f.endpointId, conversationId: openConversationId, principalId: randomUUID(), userId: f.founderUserId });
    expect(await f.service.authorizeFounderFallbackPublication(db, notice!)).toBe(false);
    await db.delete(chatConversations).where(eq(chatConversations.id, openConversationId));
    expect(await f.service.authorizeFounderFallbackPublication(db, notice!)).toBe(true);

    // A published /close ends the DM for the outbox, so it ends it as a target too.
    await db.insert(chatPublications).values({ companyId: f.companyId, endpointId: f.endpointId, conversationId: f.conversationId,
      issueId: f.dmIssueId, idempotencyKey: `control:close:${randomUUID()}`, payload: { text: "Closed" }, state: "published", publishedAt: now });
    expect(await f.service.authorizeFounderFallbackPublication(db, notice!)).toBe(false);
    expect(await f.service.sweep()).toMatchObject({ targets: 0, inserted: 0 });
  });

  it("re-arms an escalation cancelled before delivery when it qualifies again", async () => {
    const f = await fixture();
    // An escalation the recovered agent picks up on its task no longer qualifies.
    const escalation = await interaction(f, { addresseeAgentId: f.agentId });
    await failAgent(f, start);
    at(21);
    await f.service.sweep();
    const [notice] = await rows(f);
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId: f.otherIssueId, status: "succeeded",
      createdAt: now, startedAt: now, finishedAt: now });
    expect(await f.service.authorizeFounderFallbackPublication(db, notice!)).toBe(false);
    // The native transport claim cancels each row that fails its re-proof before provider I/O.
    await db.update(chatPublications).set({ state: "cancelled", redactedError: "Task control requester or destination is no longer authorized" })
      .where(eq(chatPublications.companyId, f.companyId));
    at(30);
    await failAgent(f, now);
    at(40);
    // Not yet past the bound of the new outage: nothing re-armed early.
    expect((await f.service.sweep()).inserted).toBe(0);
    at(51);
    expect((await f.service.sweep()).inserted).toBe(1);
    expect((await rows(f)).map(row => [row.idempotencyKey, row.state])).toEqual([
      [asksKey(f, [escalation.id]), "cancelled"],
      [asksKey(f, [escalation.id], 1), "pending"],
    ]);
    expect(await f.service.authorizeFounderFallbackPublication(db, (await rows(f))[1]!)).toBe(true);
    at(60);
    expect((await f.service.sweep()).inserted).toBe(0);
  });

  it("re-arms a definitely-unsent ask once endpoint authority is restored", async () => {
    const f = await fixture();
    await interaction(f, { addresseeUserId: f.founderUserId });
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

  it("never re-arms an ask that may have reached the founder or failed", async () => {
    for (const outcome of [
      { state: "cancelled" as const, redactedError: OPERATOR_UNCONFIRMED_DELIVERY_CANCELLATION },
      { state: "cancelled" as const, providerMessageId: "provider-message" },
      { state: "delivery_unknown" as const },
      { state: "published" as const },
      { state: "failed" as const, redactedError: "Discord rejected the message" },
    ]) {
      const f = await fixture();
      const decision = await interaction(f, { addresseeUserId: f.founderUserId });
      at(21);
      await f.service.sweep();
      const [notice] = await rows(f);
      await db.update(chatPublications).set(outcome).where(eq(chatPublications.id, notice!.id));
      at(40);
      expect((await f.service.sweep()).inserted).toBe(0);
      expect((await rows(f)).filter(row => row.idempotencyKey.includes(decision.id))).toHaveLength(1);
      for (const table of [chatPublications, chatDeliveries, chatIdentityLinks, chatExternalPrincipals, chatConversations,
        chatEndpoints, toolConnections, toolApplications, issueThreadInteractions, heartbeatRuns, issues, companyMemberships,
        agents, companies]) await db.delete(table);
    }
  });

  it("treats a delivered retired single-item notice as the item's alert and retracts it", async () => {
    const f = await fixture();
    const decision = await interaction(f, { addresseeUserId: f.founderUserId });
    await db.insert(chatPublications).values({ companyId: f.companyId, endpointId: f.endpointId, conversationId: f.conversationId,
      issueId: f.dmIssueId, idempotencyKey: founderFallbackKey({ endpointId: f.endpointId, kind: "item", interactionId: decision.id }),
      payload: { text: "Paperclip fallback notice (automatic, not from Master Builder)." }, state: "published", publishedAt: start });
    at(30);
    expect((await f.service.sweep()).inserted).toBe(0);
    await resolve(decision.id);
    expect((await f.service.sweep()).inserted).toBe(1);
    expect((await rows(f)).at(-1)!.idempotencyKey).toBe(doneKey(f, decision.id));
  });

  it("re-arms once under concurrent sweeps and restarts, and stops after the re-arm limit", async () => {
    const f = await fixture();
    const decision = await interaction(f, { addresseeUserId: f.founderUserId });
    at(21);
    await f.service.sweep();
    const base = asksKey(f, [decision.id]);
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

  it("lists an item in only one message under concurrent sweeps", async () => {
    const f = await fixture();
    for (let index = 0; index < 3; index += 1) {
      await interaction(f, { addresseeUserId: f.founderUserId, title: `Decision ${index}`, createdAt: new Date(start.getTime() + index * 1000) });
    }
    at(21);
    const restarted = createFounderFallbackNotices(db, { enabled: true, boundMs: BOUND }, () => now);
    const results = await Promise.all([f.service.sweep(), restarted.sweep(), f.service.sweep()]);
    expect(results.reduce((sum, result) => sum + result.inserted, 0)).toBe(1);
    expect(await rows(f)).toHaveLength(1);
  });

  it("reports the real next deadline and no deadline when idle", async () => {
    const f = await fixture();
    expect(await f.service.sweep()).toEqual({ targets: 1, inserted: 0, nextDueAt: null, awaitingOutbox: false });
    // A founder decision on another task has its own deadline, whatever the agent's state.
    const decision = await interaction(f, { addresseeUserId: f.founderUserId, createdAt: new Date(start.getTime() + 2 * MINUTE) });
    expect((await f.service.sweep()).nextDueAt).toBe(decision.createdAt.getTime() + BOUND);
    // A founder card on the DM task itself publishes natively and has no deadline here.
    await interaction(f, { addresseeUserId: f.founderUserId, issueId: f.dmIssueId, createdAt: new Date(start.getTime() + MINUTE) });
    expect((await f.service.sweep()).nextDueAt).toBe(decision.createdAt.getTime() + BOUND);
    const escalation = await interaction(f, { addresseeAgentId: f.agentId, createdAt: new Date(start.getTime() + 3 * MINUTE) });
    at(10);
    expect((await f.service.sweep()).nextDueAt).toBe(decision.createdAt.getTime() + BOUND);
    await resolve(decision.id);
    expect((await f.service.sweep()).nextDueAt).toBe(escalation.createdAt.getTime() + BOUND);
    await failAgent(f, new Date(start.getTime() + 5 * MINUTE));
    // While the agent is down its bound replaces the escalation deadline.
    expect((await f.service.sweep()).nextDueAt).toBe(start.getTime() + 25 * MINUTE);
    // An unavailable agent alone has no deadline: its state is never an alert.
    await resolve(escalation.id);
    expect((await f.service.sweep()).nextDueAt).toBeNull();
    await db.update(issueThreadInteractions).set({ status: "pending" }).where(inArray(issueThreadInteractions.id, [decision.id, escalation.id]));
    at(26);
    expect(await f.service.sweep()).toMatchObject({ inserted: 1, nextDueAt: null, awaitingOutbox: false });
    // The ask in flight waits for the outbox, not a timer; once delivered, the reminder is the deadline.
    expect(await f.service.sweep()).toMatchObject({ inserted: 0, nextDueAt: null, awaitingOutbox: true });
    await deliver(f);
    expect(await f.service.sweep()).toMatchObject({ inserted: 0, nextDueAt: now.getTime() + FOUNDER_REMINDER_INTERVAL_MS, awaitingOutbox: false });
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
    const real = (boundMs = BOUND) => createFounderFallbackNotices(db, { enabled: true, boundMs, quietHours: false });

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

    // A decision crosses the bound at its own deadline: one ask, then quiet.
    const decision = await interaction(f, { addresseeUserId: f.founderUserId, createdAt: new Date() });
    await run(real(120), async () => {
      await quiet();
      await quiet();
      // The ask's own outbox write is observed while it is in flight, so one
      // more sweep sees it waiting for the outbox and nothing new to send.
      expect(sweeps.map(sweep => sweep.inserted)).toEqual([0, 1, 0]);
      await quiet();
      expect(sweeps).toHaveLength(3);
    });

    // Resolution with the ask in flight waits for that outbox row's settlement.
    await db.update(issueThreadInteractions).set({ status: "accepted" }).where(eq(issueThreadInteractions.id, decision.id));
    await run(real(120), async () => {
      await quiet();
      expect(sweeps).toHaveLength(1);
      await db.transaction(async tx => {
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.chatPublications);
        await tx.update(chatPublications).set({ state: "published", publishedAt: new Date() })
          .where(like(chatPublications.idempotencyKey, `${FOUNDER_FALLBACK_KEY_PREFIX}%:asks:%`));
      });
      await quiet();
      // The retraction's own outbox write is the last hint observed, and the
      // sweep it triggers finds no ask in flight.
      expect(sweeps.map(sweep => sweep.inserted)).toEqual([0, 1, 0]);
      // Completed history alone keeps nothing scheduled, including outbox churn.
      await db.transaction(async tx => notifyDeliveryWork(tx, DELIVERY_QUEUES.chatPublications));
      await quiet();
      expect(sweeps).toHaveLength(3);
    });
    expect(await kinds(f)).toEqual(["asks", "done"]);
  });

  describe("outbox settlement observation", () => {
    // A resolved decision whose ask is still in the outbox: the sweep reports
    // awaitingOutbox, and that row's settlement decides the retraction.
    async function inFlightResolution() {
      const f = await fixture();
      const decision = await interaction(f, { addresseeUserId: f.founderUserId });
      at(21);
      expect((await f.service.sweep()).inserted).toBe(1);
      await resolve(decision.id);
      return f;
    }
    const settleAsk = (f: { companyId: string }) => db.transaction(async tx => {
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.chatPublications);
      await tx.update(chatPublications).set({ state: "published", publishedAt: new Date() }).where(and(
        eq(chatPublications.companyId, f.companyId), like(chatPublications.idempotencyKey, `${FOUNDER_FALLBACK_KEY_PREFIX}%:asks:%`)));
    });
    const retracted = async (f: { companyId: string }) => (await rows(f)).filter(row => row.idempotencyKey.includes(":done:"));
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

    it("retracts when the in-flight ask settles after the read but before the sweep returns", async () => {
      const f = await inFlightResolution();
      const h = harness(f.service, { afterRead: () => settleAsk(f) });
      try {
        await h.worker.ready;
        await vi.waitFor(async () => expect(await retracted(f)).toHaveLength(1), { timeout: 3000, interval: 25 });
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
      expect(await retracted(f)).toHaveLength(1);
    });

    it("retracts when the ask settled before the read, without any later hint", async () => {
      const f = await inFlightResolution();
      const h = harness(f.service, { beforeRead: () => settleAsk(f) });
      try {
        await h.worker.ready;
        await vi.waitFor(async () => expect(await retracted(f)).toHaveLength(1), { timeout: 3000, interval: 25 });
        await quiet();
        expect(h.sweeps[0]).toMatchObject({ inserted: 1, awaitingOutbox: false });
        expect(h.observers).toEqual({ live: 0, max: 1 });
        expect(h.errors).toEqual([]);
      } finally {
        await h.close();
      }
    });

    it("leaves no observer, deadline or later sweep when stopped during a sweep", async () => {
      const f = await inFlightResolution();
      let release!: () => void;
      let reached!: () => void;
      const blocked = new Promise<void>(resolve => { reached = resolve; });
      const h = harness(f.service, { afterRead: () => { reached(); return new Promise<void>(resolve => { release = resolve; }); } });
      await blocked;
      const observedDuringSweep = h.observers.live;
      const stopping = h.worker.stop();
      const observedOnceStopping = h.observers.live;
      await settleAsk(f);
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
      expect(await retracted(f)).toEqual([]);
    });

    it("never sweeps or observes when stopped before its first run", async () => {
      const f = await inFlightResolution();
      const h = harness(f.service);
      await h.worker.stop();
      await h.worker.stop();
      await h.coordinator.stop();
      await quiet();
      expect(h.sweeps).toEqual([]);
      expect(h.observers).toEqual({ live: 0, max: 0 });
    });

    it("keeps the obligation through a failed sweep and releases the observer once it settles", async () => {
      const f = await inFlightResolution();
      const h = harness(f.service, { beforeRead: async () => { throw new Error("transient read failure"); } });
      try {
        await vi.waitFor(() => expect(h.sweeps.length).toBeGreaterThanOrEqual(1), { timeout: 3000, interval: 10 });
        expect(h.errors).toHaveLength(1);
        expect(h.sweeps[0]).toMatchObject({ awaitingOutbox: true });
        expect(h.observers.live).toBe(1);
        await settleAsk(f);
        await vi.waitFor(async () => expect(await retracted(f)).toHaveLength(1), { timeout: 3000, interval: 25 });
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
        const f = await inFlightResolution();
        const h = gated(f.service, retryMs);
        try {
          await h.worker.ready;
          expect(h.sweeps).toHaveLength(1);
          startTaskDrain({ purpose: "idle" });
          await settleAsk(f);
          await quiet();
          expect(h.sweeps).toHaveLength(1);
          expect(await retracted(f)).toHaveLength(0);
          stopTaskDrain();
          await vi.waitFor(async () => expect(await retracted(f)).toHaveLength(1), { timeout: 3000, interval: 25 });
          await settlesQuietly(h);
        } finally {
          await h.close();
        }
      });

      it("retains the first relevant producer hint seen during idle drain", async () => {
        // On the real clock: the delivered ask's reminder deadline is hours away.
        const f = await fixture();
        const service = createFounderFallbackNotices(db, { enabled: true, boundMs: BOUND, quietHours: false });
        const decision = await interaction(f, { addresseeUserId: f.founderUserId, createdAt: new Date(Date.now() - 21 * MINUTE) });
        expect((await service.sweep()).inserted).toBe(1);
        await db.update(chatPublications).set({ state: "published", publishedAt: new Date() }).where(eq(chatPublications.companyId, f.companyId));
        const h = gated(service, 60_000);
        try {
          await h.worker.ready;
          expect(h.sweeps).toEqual([expect.objectContaining({ inserted: 0, awaitingOutbox: false })]);
          startTaskDrain({ purpose: "idle" });
          await resolve(decision.id);
          publishLiveEvent({ companyId: f.companyId, type: "activity.logged", payload: { action: "issue.thread_interaction_resolved" } });
          await quiet();
          expect(h.sweeps).toHaveLength(1);
          stopTaskDrain();
          await vi.waitFor(async () => expect(await retracted(f)).toHaveLength(1), { timeout: 3000, interval: 25 });
          await settlesQuietly(h);
        } finally {
          await h.close();
        }
      });

      it("keeps a failed sweep's obligation when its retry falls in idle drain", async () => {
        const f = await inFlightResolution();
        const h = gated(f.service, 20, { beforeRead: async () => {
          startTaskDrain({ purpose: "idle" });
          throw new Error("transient read failure");
        } });
        try {
          await vi.waitFor(() => expect(h.errors).toHaveLength(1), { timeout: 3000, interval: 10 });
          await settleAsk(f);
          await quiet();
          // Retries pass through the drain without reading.
          expect(h.sweeps).toEqual([]);
          expect(await retracted(f)).toHaveLength(0);
          stopTaskDrain();
          await vi.waitFor(async () => expect(await retracted(f)).toHaveLength(1), { timeout: 3000, interval: 25 });
          h.errors.length = 0;
          await settlesQuietly(h);
        } finally {
          await h.close();
        }
      });

      it("runs a deadline that falls due during idle drain once it ends", async () => {
        const f = await fixture();
        await interaction(f, { addresseeUserId: f.founderUserId, createdAt: new Date() });
        const service = createFounderFallbackNotices(db, { enabled: true, boundMs: 120, quietHours: false });
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
          await quiet();
          // The ask stays in flight here (no transport), so the worker waits on the outbox, not a timer.
          expect(h.sweeps.at(-1)).toMatchObject({ inserted: 0, awaitingOutbox: true });
          expect(h.coordinator.nextWakeAt()).toBeNull();
          expect(await kinds(f)).toEqual(["asks"]);
        } finally {
          await h.close();
        }
      });

      it("retains a settlement observed during warm standby until it ends", async () => {
        const f = await inFlightResolution();
        const h = gated(f.service, 20);
        try {
          await h.worker.ready;
          standby = true;
          await settleAsk(f);
          await quiet();
          expect(h.sweeps).toHaveLength(1);
          expect(await retracted(f)).toHaveLength(0);
          standby = false;
          await vi.waitFor(async () => expect(await retracted(f)).toHaveLength(1), { timeout: 3000, interval: 25 });
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

  it("alerts and retracts only tasks the founder may read, re-proved at the claim", async () => {
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    try {
      const f = await fixture();
      const visibleIssueId = randomUUID(), hiddenIssueId = randomUUID();
      await db.insert(issues).values([
        { id: visibleIssueId, companyId: f.companyId, title: "Granted private task", identifier: "F-3", visibility: "private" },
        { id: hiddenIssueId, companyId: f.companyId, title: "Hidden private task", identifier: "F-4", visibility: "private" },
      ]);
      const [grant] = await db.insert(issueAccessGrants).values({ issueId: visibleIssueId, subjectType: "user",
        subjectId: f.founderUserId, source: "explicit", grantedByUserId: f.founderUserId }).returning();
      const visible = await interaction(f, { issueId: visibleIssueId, addresseeUserId: f.founderUserId, title: "Visible decision" });
      const hidden = await interaction(f, { issueId: hiddenIssueId, addresseeUserId: f.founderUserId, title: "Hidden decision" });
      const hiddenEscalation = await interaction(f, { issueId: hiddenIssueId, addresseeAgentId: f.agentId, title: "Hidden escalation" });
      // A pending item addressed to the same founder in another company is never listed here.
      const otherCompanyId = randomUUID(), otherCompanyIssueId = randomUUID();
      await db.insert(companies).values({ id: otherCompanyId, name: "Other", issuePrefix: `O${otherCompanyId.slice(0, 4).toUpperCase()}` });
      await db.insert(issues).values({ id: otherCompanyIssueId, companyId: otherCompanyId, title: "Other company task", identifier: "O-1" });
      await db.insert(issueThreadInteractions).values({ companyId: otherCompanyId, issueId: otherCompanyIssueId,
        kind: "request_confirmation", payload: { version: 1, prompt: "Approve?" } as never, addresseeUserId: f.founderUserId, createdAt: start });
      await failAgent(f, start);
      at(21);
      expect((await f.service.sweep()).inserted).toBe(1);
      const [ask] = await rows(f);
      expect(ask!.idempotencyKey).toBe(asksKey(f, [visible.id]));
      expect(text(ask!)).not.toContain("Hidden");
      expect(text(ask!)).not.toContain("F-4");
      for (const ids of [[hidden.id], [hiddenEscalation.id], [visible.id, hidden.id]]) {
        expect(await f.service.authorizeFounderFallbackPublication(db, { ...ask!, idempotencyKey: asksKey(f, ids) })).toBe(false);
      }

      // The grant is revoked after delivery: the resolution of the now-hidden task is not retracted into the DM.
      await deliver(f);
      await db.update(issueAccessGrants).set({ revokedAt: now }).where(eq(issueAccessGrants.id, grant!.id));
      expect(await f.service.authorizeFounderFallbackPublication(db, ask!)).toBe(false);
      await resolve(visible.id);
      at(22);
      expect((await f.service.sweep()).inserted).toBe(0);
      expect(await f.service.authorizeFounderFallbackPublication(db, { ...ask!, idempotencyKey: doneKey(f, visible.id) })).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("bounds a message to five asks and lists the rest in the next one", async () => {
    const f = await fixture();
    const created = [];
    for (let index = 0; index < 7; index += 1) {
      created.push(await interaction(f, { addresseeUserId: f.founderUserId, title: `Decision ${index}`,
        createdAt: new Date(start.getTime() + index * 1000) }));
    }
    at(21);
    expect(await f.service.sweep()).toMatchObject({ inserted: 1, nextDueAt: now.getTime() });
    expect(await f.service.sweep()).toMatchObject({ inserted: 1 });
    const [first, second] = await rows(f);
    expect(first!.idempotencyKey).toBe(asksKey(f, created.slice(0, 5).map(row => row.id)));
    expect(second!.idempotencyKey).toBe(asksKey(f, created.slice(5).map(row => row.id)));
    expect(text(first!).split("\n\n")).toHaveLength(5);
    expect((await f.service.sweep()).inserted).toBe(0);
  });
});
