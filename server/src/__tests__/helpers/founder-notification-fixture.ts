import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
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
  type createDb,
  issues,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import type { AttentionItem } from "@paperclipai/shared";
import { listFounderRoutes, upsertFounderRoute } from "../../services/founder-notifications.js";

type TestDb = ReturnType<typeof createDb>;

/**
 * Seeds a company with a founder, an assigned agent, a task and a verified
 * founder DM on a fake chat endpoint. No provider is ever contacted.
 */
export function founderNotificationFixtures(getDb: () => TestDb) {
  async function seed(options: { provider?: "telegram" | "slack"; publicationMode?: "automatic" | "explicit" } = {}) {
    const provider = options.provider ?? "telegram";
    const companyId = randomUUID();
    const agentId = randomUUID();
    const reviewerId = randomUUID();
    const founderUserId = `founder-${randomUUID()}`;
    const prefix = `FN${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await getDb().insert(companies).values({ id: companyId, name: `Founder ${companyId}`, issuePrefix: prefix });
    await getDb().insert(agents).values([
      { id: agentId, companyId, name: "Engineer", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: reviewerId, companyId, name: "Reviewer", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    const now = new Date();
    await getDb().insert(authUsers).values({ id: founderUserId, name: "Founder", email: `${founderUserId}@example.com`, emailVerified: true, createdAt: now, updatedAt: now });
    await getDb().insert(companyMemberships).values({ companyId, principalType: "user", principalId: founderUserId, status: "active", membershipRole: "owner" });
    const [chatTask] = await getDb().insert(issues).values({ companyId, title: "Founder DM chat", status: "done", assigneeAgentId: agentId }).returning();
    const [task] = await getDb()
      .insert(issues)
      .values({ companyId, title: "Ship the notification canary", status: "blocked", assigneeAgentId: agentId, identifier: `${prefix}-7`, issueNumber: 7 })
      .returning();

    const applicationId = randomUUID();
    const connectionId = randomUUID();
    const endpointId = randomUUID();
    await getDb().insert(toolApplications).values({ id: applicationId, companyId, applicationKey: `chat:${provider}:${endpointId}`, name: provider, type: "chat", status: "active" });
    await getDb().insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: `${provider} channel`, uid: `chat-${provider}-${endpointId}`, connectionPurpose: "channel", transport: "chat_sdk", status: "active", enabled: true });
    await getDb().insert(chatEndpoints).values({
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
    const [conversation] = await getDb()
      .insert(chatConversations)
      .values({ companyId, endpointId, issueId: chatTask.id, externalConversationId: "founder-dm", externalThreadId: `${provider}:founder-dm`, externalLabel: "Founder", isDirectMessage: true, state: "completed" })
      .returning();
    const principal = await addPrincipal(companyId, endpointId, "founder-external", founderUserId);
    await addDelivery(companyId, endpointId, conversation.id, principal.id);
    return { companyId, agentId, reviewerId, founderUserId, task, chatTask, endpointId, conversation, principal };
  }

  async function addPrincipal(companyId: string, endpointId: string, externalId: string, linkedUserId: string | null) {
    const [principal] = await getDb()
      .insert(chatExternalPrincipals)
      .values({ companyId, provider: "telegram", providerAccountId: "bot", externalId, kind: "user" })
      .returning();
    if (linkedUserId) {
      await getDb().insert(chatIdentityLinks).values({ companyId, endpointId, principalId: principal.id, paperclipUserId: linkedUserId, status: "linked", confirmedAt: new Date() });
    }
    return principal;
  }

  async function addDelivery(companyId: string, endpointId: string, conversationId: string, principalId: string) {
    await getDb().insert(chatDeliveries).values({
      companyId, endpointId, conversationId, principalId,
      providerEventId: randomUUID(), deduplicationKey: randomUUID(), eventKind: "direct_message", normalizedEvent: {}, state: "processed",
    });
  }

  async function enabledRoute(fixture: Awaited<ReturnType<typeof seed>>, stallAfterMs?: number) {
    await upsertFounderRoute(
      getDb(),
      fixture.companyId,
      { recipientUserId: fixture.founderUserId, endpointId: fixture.endpointId, conversationId: fixture.conversation.id, enabled: true, stallAfterMs },
      "owner-user",
    );
    const [route] = await listFounderRoutes(getDb(), fixture.companyId, { enabledOnly: true });
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
    return getDb()
      .select()
      .from(chatPublications)
      .where(and(eq(chatPublications.companyId, companyId), like(chatPublications.idempotencyKey, `${prefix}%`)));
  }

  async function episodes(companyId: string) {
    return getDb()
      .select()
      .from(chatActions)
      .where(and(eq(chatActions.companyId, companyId), eq(chatActions.kind, "founder_notification_episode")));
  }

  return { seed, addPrincipal, addDelivery, enabledRoute, attentionItem, founderPublications, episodes };
}

export type FounderNotificationFixture = Awaited<ReturnType<ReturnType<typeof founderNotificationFixtures>["seed"]>>;
