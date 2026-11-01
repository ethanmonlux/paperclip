import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  assets,
  authUsers,
  browserUseRuns,
  browserUseSessions,
  chatActions,
  chatExternalPrincipals,
  chatTeamsFileTransfers,
  connectionGrants,
  dotAgentBindings,
  dotRunnerAssignments,
  dotRunnerOperations,
  heartbeatRuns,
  issueAttachments,
  issueComments,
  mcpOauthClients,
  mcpOauthGrants,
  nativeRunFinalizations,
  toolInvocations,
  toolPolicies,
  chatConversations,
  chatEndpoints,
  chatPublications,
  chatVoiceReplies,
  chatVoiceSessions,
  companies,
  companyMemberships,
  createDb,
  instanceSettings,
  issues,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import { instanceSettingsService } from "../services/instance-settings.js";
import { browserUseService } from "../services/browser-use.js";
import { teamsFileTransferService, type TeamsFileTransferAuthority } from "../services/chat-teams-file-transfers.js";
import { dotRunnerBroker } from "../services/dot-runner-broker.js";
import type { PluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import type { McpPrincipal } from "../services/public-mcp/oauth.js";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { configureSpekoSessionTools } from "../services/voice/speko-tool-setup.js";
import { SpekoProviderError } from "../services/voice/speko-provider.js";
import { voiceSessionService } from "../services/voice/voice-session-service.js";
import { voiceSessionStore } from "../services/voice/voice-session-store.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// FAC-797 / STA-21 stage 26: executed behaviour for the effect-reservation
// gate (admission-design r2 §2.4) rows f–k, which stage 25 covered only
// structurally, and R18: every actual Speko configuration attempt is bound
// to a durable in-flight reservation (reconnect, retry after a definitive
// rejection, unknown outcome, and the final voice-defaults PATCH). Each case
// drives the real writer against real embedded Postgres with an isolated
// provider fixture; no live credential or network. Held: the writer refuses
// before its reservation, writes nothing new and calls no provider. Open:
// the same writer reserves and calls the provider fixture.

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping upgrade fence f–k effect tests on this host: ${support.reason ?? "unsupported environment"}`);
}

const LOCK_CLASS = 0x50435546;
const LOCK_OBJECT = 1;
const FENCE_KEY = "upgrade-admission-fence/v1";

function fenceState(phase: string, extra: Record<string, unknown> = {}) {
  return {
    version: 1, epoch: 7, phase, initializedBy: "fresh_install", initializationId: randomUUID(),
    initializedAt: new Date().toISOString(), identity: null, owner: null, heldUntil: null, leaseUntil: null,
    reason: null, candidate: null, history: [], ...extra,
  };
}
const heldFence = () => fenceState("held", {
  owner: { tokenSha256: "b".repeat(64), actor: { type: "user", id: "owner" }, heldAt: new Date().toISOString() },
  heldUntil: new Date(Date.now() + 3600_000).toISOString(),
});

describeEmbedded("upgrade admission fence, phase 2a effect reservations rows f–k", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let other: ReturnType<typeof createDb>;
  let home: string;
  beforeAll(async () => {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-fence-effects-fk-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "fence-effects-fk-fixture");
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "fence-effects-fk-test-only-signing-value");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", Buffer.alloc(32, 79).toString("base64"));
    vi.stubEnv("PAPERCLIP_API_URL", "http://127.0.0.1:3100");
    temporary = await startEmbeddedPostgresTestDatabase("upgrade-fence-effects-fk-");
    db = createDb(temporary.connectionString);
    other = createDb(temporary.connectionString);
  }, 90_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await other?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await db.delete(instanceSettings).where(eq(instanceSettings.singletonKey, FENCE_KEY));
  });

  async function putFence(general: Record<string, unknown> | null) {
    await db.delete(instanceSettings).where(eq(instanceSettings.singletonKey, FENCE_KEY));
    if (general) await db.insert(instanceSettings).values({ singletonKey: FENCE_KEY, general });
  }
  const holdFence = () => putFence(heldFence());
  const openFence = () => putFence(fenceState("open"));

  async function company(prefix: string) {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: `Fence ${prefix}`, issuePrefix: `${prefix}${id.slice(0, 5).toUpperCase()}` });
    return id;
  }

  /** Hold the fence's exclusive lock on another connection for the duration of `work`. */
  async function withExclusiveFenceLock<T>(work: () => Promise<T>): Promise<T> {
    let release!: () => void;
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => { locked = resolve; });
    const done = new Promise<void>((resolve) => { release = resolve; });
    const holder = other.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_CLASS}::int4, ${LOCK_OBJECT}::int4)`);
      locked();
      await done;
    });
    await holding;
    try {
      return await work();
    } finally {
      release();
      await holder;
    }
  }

  async function spekoEndpoint(companyId: string) {
    const endpointId = randomUUID(), agentId = randomUUID(), applicationId = randomUUID(), connectionId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Voice agent", role: "operator", status: "idle", adapterType: "paperclip_runner" });
    await db.insert(toolApplications).values({ id: applicationId, companyId, applicationKey: `chat:speko:${endpointId}`, name: "Speko", type: "chat", status: "active" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Speko", uid: endpointId, connectionPurpose: "channel", transport: "voice", config: { provider: "speko" }, status: "active", enabled: true });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, provider: "speko", publicId: randomUUID(), assignedAgentId: agentId, status: "active", setup: { step: "complete", runtimeGeneration: 1 } });
    return { endpointId, agentId };
  }

  // ------------------------------------------------- row g: Speko setup, R18
  describe("g / R18: Speko tool and lifecycle setup receipts", () => {
    type Hook = { id: string; url: string; events: string[]; allAgents: boolean; agentIds: string[]; filterTags: Record<string, string> };
    type Tool = { id: string; name: string; source: { kind: string; url: string } };

    async function spekoFixture() {
      const companyId = await company("SK");
      const { endpointId } = await spekoEndpoint(companyId);
      const tools: Tool[] = [];
      const hooks: Hook[] = [];
      const lifecycle = async () => (await db.select().from(chatActions).where(and(
        eq(chatActions.endpointId, endpointId), eq(chatActions.kind, "speko_lifecycle_setup"))));
      const toolReceipts = () => db.select().from(chatActions).where(and(
        eq(chatActions.endpointId, endpointId), eq(chatActions.kind, "speko_tool_setup")));
      // What the durable lifecycle receipt said at the moment of each provider write.
      const observed: Record<"webhook" | "voiceDefaults" | "tool", string[]> = { webhook: [], voiceDefaults: [], tool: [] };
      const statuses = async () => (await lifecycle()).map((row) => row.status).join(",");
      const client = {
        listTools: vi.fn(async () => structuredClone(tools)),
        configureTool: vi.fn(async (_agentId: string, definition: { name: string; source: { kind: string; url: string } }, _secret: string, id?: string) => {
          const receipt = (await toolReceipts()).find((row) => row.payload.name === definition.name);
          observed.tool.push(receipt?.status ?? "absent");
          const tool = { id: id ?? randomUUID(), name: definition.name, source: definition.source };
          const index = tools.findIndex((t) => t.id === tool.id);
          if (index === -1) tools.push(tool); else tools[index] = tool;
          return { id: tool.id };
        }),
        listWebhooks: vi.fn(async () => structuredClone(hooks)),
        configureWebhook: vi.fn(async (agentId: string, url: string, _secret: string, id?: string) => {
          observed.webhook.push(await statuses());
          const hook = { id: id ?? "hook_fixture", url, events: ["call.pre_call", "call.status", "call.report"], allAgents: false, agentIds: [agentId], filterTags: {} };
          hooks.splice(0, hooks.length, hook);
          return { id: hook.id };
        }),
        configureVoiceDefaults: vi.fn(async (_agentId: string) => {
          observed.voiceDefaults.push(await statuses());
        }),
      };
      const input = {
        companyId, endpointId, agentId: "agent_fixture", callbackUrl: "https://voice.example.test/tools",
        signingSecret: "whsec_fixture", client: client as never, assertOwned: async () => {},
      };
      const setup = () => configureSpekoSessionTools(db, input);
      return { companyId, endpointId, client, input, setup, lifecycle, toolReceipts, observed };
    }

    it("held: refuses before any receipt and calls no provider write", async () => {
      const f = await spekoFixture();
      await holdFence();
      await expect(f.setup()).rejects.toMatchObject({ status: 409, details: { code: "upgrade_fence_held" } });
      expect(f.client.configureTool).not.toHaveBeenCalled();
      expect(f.client.configureWebhook).not.toHaveBeenCalled();
      expect(f.client.configureVoiceDefaults).not.toHaveBeenCalled();
      expect(await f.toolReceipts()).toHaveLength(0);
      expect(await f.lifecycle()).toHaveLength(0);
    });

    it("held on reconnect: completed receipts are left exactly as they were", async () => {
      const f = await spekoFixture();
      await openFence();
      await f.setup();
      const before = JSON.stringify([await f.toolReceipts(), await f.lifecycle()]);
      f.client.configureTool.mockClear(); f.client.configureWebhook.mockClear(); f.client.configureVoiceDefaults.mockClear();
      await holdFence();
      await expect(f.setup()).rejects.toMatchObject({ status: 409 });
      expect(JSON.stringify([await f.toolReceipts(), await f.lifecycle()])).toBe(before);
      expect(f.client.configureTool).not.toHaveBeenCalled();
      expect(f.client.configureWebhook).not.toHaveBeenCalled();
      expect(f.client.configureVoiceDefaults).not.toHaveBeenCalled();
    });

    it("busy: an exclusive fence lock refuses without waiting and writes nothing", async () => {
      const f = await spekoFixture();
      await openFence();
      const started = Date.now();
      await expect(withExclusiveFenceLock(() => f.setup())).rejects.toMatchObject({ status: 409, details: { code: "upgrade_fence_busy" } });
      expect(Date.now() - started).toBeLessThan(4_000);
      expect(f.client.configureTool).not.toHaveBeenCalled();
      expect(await f.toolReceipts()).toHaveLength(0);
    });

    it("open: the first setup holds an in-flight lifecycle receipt through both provider writes, then completes", async () => {
      const f = await spekoFixture();
      await openFence();
      await f.setup();
      expect(f.observed.webhook).toEqual(["processing"]);
      expect(f.observed.voiceDefaults).toEqual(["processing"]);
      expect(f.observed.tool).toEqual(["processing", "processing", "processing"]);
      expect(await f.lifecycle()).toMatchObject([{ status: "completed", result: { webhookId: "hook_fixture" } }]);
    });

    it("R18: a reconnect re-arms the completed lifecycle receipt before the webhook PATCH", async () => {
      const f = await spekoFixture();
      await openFence();
      await f.setup();
      f.observed.webhook.length = 0; f.observed.voiceDefaults.length = 0; f.observed.tool.length = 0;
      await f.setup();
      expect(f.client.configureWebhook).toHaveBeenCalledTimes(2);
      expect(f.observed.webhook).toEqual(["processing"]);
      expect(f.observed.voiceDefaults).toEqual(["processing"]);
      // Tool reconnects were already re-armed (the local precedent).
      expect(f.observed.tool).toEqual(["processing", "processing", "processing"]);
      expect(await f.lifecycle()).toMatchObject([{ status: "completed", result: { webhookId: "hook_fixture" } }]);
    });

    it("R18: an unknown webhook outcome on reconnect leaves the receipt in flight, not its earlier completed result", async () => {
      const f = await spekoFixture();
      await openFence();
      await f.setup();
      f.client.configureWebhook.mockRejectedValueOnce(new SpekoProviderError("provider_unavailable", true));
      await expect(f.setup()).rejects.toMatchObject({ outcomeUnknown: true });
      expect((await f.lifecycle()).map((row) => row.status)).toEqual(["processing"]);
      expect(f.client.configureVoiceDefaults).toHaveBeenCalledTimes(1);
      // The exact hook still exists, so the same reconnect may repair it (PATCH by id).
      await f.setup();
      expect(f.client.configureWebhook.mock.calls.at(-1)?.[3]).toBe("hook_fixture");
      expect(await f.lifecycle()).toMatchObject([{ status: "completed" }]);
    });

    it("R18: a retry after a definitive webhook rejection re-arms the failed receipt before the PATCH", async () => {
      const f = await spekoFixture();
      await openFence();
      f.client.configureWebhook.mockRejectedValueOnce(new SpekoProviderError("rate_limited", false, 429));
      await expect(f.setup()).rejects.toMatchObject({ outcomeUnknown: false });
      expect((await f.lifecycle()).map((row) => row.status)).toEqual(["failed"]);
      f.observed.webhook.length = 0;
      await f.setup();
      expect(f.observed.webhook).toEqual(["processing"]);
      expect(await f.lifecycle()).toMatchObject([{ status: "completed", result: { webhookId: "hook_fixture" } }]);
    });

    it("R18: an unknown voice-defaults outcome leaves the lifecycle receipt in flight", async () => {
      const f = await spekoFixture();
      await openFence();
      f.client.configureVoiceDefaults.mockRejectedValueOnce(new SpekoProviderError("provider_unavailable", true));
      await expect(f.setup()).rejects.toMatchObject({ outcomeUnknown: true });
      const [row] = await f.lifecycle();
      expect(row).toMatchObject({ status: "processing", result: { webhookId: "hook_fixture" } });
    });

    it("R18: a definitive voice-defaults rejection marks the lifecycle receipt failed, keeping the webhook id", async () => {
      const f = await spekoFixture();
      await openFence();
      f.client.configureVoiceDefaults.mockRejectedValueOnce(new SpekoProviderError("credentials_rejected", false, 401));
      await expect(f.setup()).rejects.toMatchObject({ outcomeUnknown: false });
      expect(await f.lifecycle()).toMatchObject([{ status: "failed", result: { webhookId: "hook_fixture" } }]);
      await f.setup();
      expect(await f.lifecycle()).toMatchObject([{ status: "completed", result: { webhookId: "hook_fixture" } }]);
    });

    it("R18: a reconnect refused by a held fence after a failed attempt keeps the failed receipt and calls nothing", async () => {
      const f = await spekoFixture();
      await openFence();
      f.client.configureWebhook.mockRejectedValueOnce(new SpekoProviderError("rate_limited", false, 429));
      await expect(f.setup()).rejects.toMatchObject({ outcomeUnknown: false });
      f.client.configureWebhook.mockClear(); f.client.configureTool.mockClear();
      await holdFence();
      await expect(f.setup()).rejects.toMatchObject({ status: 409 });
      expect(f.client.configureWebhook).not.toHaveBeenCalled();
      expect((await f.lifecycle()).map((row) => row.status)).toEqual(["failed"]);
    });
  });

  // ------------------------------------------------------ row h: voice push
  describe("h: Speko voice reply push dispatch intent", () => {
    async function pushFixture() {
      await instanceSettingsService(db).updateExperimental({ enableChatConnectors: true });
      const companyId = await company("VP");
      const { endpointId, agentId } = await spekoEndpoint(companyId);
      const issueId = randomUUID(), conversationId = randomUUID(), callerId = randomUUID();
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: callerId, status: "active", membershipRole: "member" });
      await db.insert(issues).values({ id: issueId, companyId, title: "Voice task", assigneeAgentId: agentId, status: "in_progress" });
      await db.insert(chatConversations).values({ id: conversationId, companyId, endpointId, issueId, externalConversationId: `speko:${conversationId}`, externalThreadId: `speko:${conversationId}`, externalLabel: "Voice", isDirectMessage: true });
      const store = voiceSessionStore(db, { allowLocalBoard: false });
      const transport = {
        createBrowserSession: vi.fn(async (_input: { toolToken: string }) => ({ sessionId: randomUUID(), transportToken: "fixture-media-token", transportUrl: "wss://media.example.test" })),
        inspectSession: vi.fn(async () => ({ status: "active", endedAt: null as string | null })),
        endSession: vi.fn(async () => ({ confirmed: true })),
        sendCallMessage: vi.fn(async (_id: string, _text: string, _mode?: "respond" | "context") => ({ messageId: "message_fixture" })),
      };
      const service = voiceSessionService(db, {
        allowLocalBoard: false, credentials: vi.fn(async () => ({ apiKey: "fixture-key", agentId: "agent_fixture" })),
        provider: () => transport as never, onQuestionAnswered: vi.fn(),
      } as never);
      const { session } = await service.start({ companyId, endpointId, issueId, caller: { id: callerId, authority: "member" as const }, idempotencyKey: randomUUID(), maxDurationSeconds: 600 });
      await db.update(chatVoiceSessions).set({ mode: "inbound_phone", state: "active" }).where(eq(chatVoiceSessions.id, session.id));
      const [publication] = await db.insert(chatPublications).values({ companyId, endpointId, conversationId, issueId, idempotencyKey: randomUUID(), state: "published", payload: { text: "Approved result" } }).returning();
      await store.enqueuePublication(companyId, publication!.id);
      const push = () => service.pushReplies(25, companyId, endpointId);
      const intents = () => db.select().from(chatActions).where(and(eq(chatActions.endpointId, endpointId), eq(chatActions.kind, "speko_voice_reply_push")));
      const reply = async () => (await db.select().from(chatVoiceReplies).where(eq(chatVoiceReplies.publicationId, publication!.id)))[0]!;
      return { transport, push, intents, reply };
    }

    it("held: no dispatch intent, no provider message; the reply stays pending", async () => {
      const f = await pushFixture();
      await holdFence();
      await f.push();
      expect(f.transport.sendCallMessage).not.toHaveBeenCalled();
      expect(await f.intents()).toHaveLength(0);
      expect((await f.reply()).deliveredAt).toBeNull();
      // Released: the pending reply is dispatched by the existing worker.
      await openFence();
      await f.push();
      expect(f.transport.sendCallMessage).toHaveBeenCalledTimes(1);
    });

    it("control: an open fence writes the dispatch intent and sends once", async () => {
      const f = await pushFixture();
      await openFence();
      await f.push();
      expect(f.transport.sendCallMessage).toHaveBeenCalledTimes(1);
      expect(await f.intents()).toMatchObject([{ status: "completed" }]);
      expect((await f.reply()).deliveredAt).toBeInstanceOf(Date);
    });
  });

  // ----------------------------------------------- row f: Teams file lane
  describe("f: Teams file transfer send claim", () => {
    const bytes = Buffer.from("Exact Teams file bytes\n");
    async function teamsFixture() {
      const companyId = await company("TF");
      const agentId = randomUUID(), applicationId = randomUUID(), connectionId = randomUUID(), assetId = randomUUID();
      const a: TeamsFileTransferAuthority = {
        companyId, endpointId: randomUUID(), conversationId: randomUUID(), issueId: randomUUID(), publicationId: randomUUID(),
        commentId: randomUUID(), attachmentId: randomUUID(), principalId: randomUUID(), authorizedUserId: "board-user",
        runtimeGeneration: 3, credentialFingerprint: "c".repeat(64), conversationGeneration: 2, sourceDigest: "d".repeat(64),
        tenantId: randomUUID(), botAppId: randomUUID(), aadObjectId: randomUUID(), providerConversationId: "a:exact-personal",
        providerUserId: "29:exact-recipient", sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length, filename: "file.txt",
      };
      await db.insert(agents).values({ id: agentId, companyId, name: "Teams", adapterType: "codex_local" });
      await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Teams", type: "chat" });
      await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, uid: randomUUID(), name: "Teams", transport: "chat_sdk", connectionPurpose: "channel" });
      await db.insert(chatEndpoints).values({ id: a.endpointId, companyId, connectionId, provider: "microsoft-teams", publicId: randomUUID(), assignedAgentId: agentId, status: "active", providerAccountId: a.tenantId, botExternalId: a.botAppId });
      await db.insert(issues).values({ id: a.issueId, companyId, title: "File output" });
      await db.insert(chatConversations).values({ id: a.conversationId, companyId, endpointId: a.endpointId, issueId: a.issueId, externalConversationId: a.providerConversationId, externalThreadId: `teams:${Buffer.from(a.providerConversationId).toString("base64url")}`, externalLabel: "Personal", isDirectMessage: true, sessionGeneration: a.conversationGeneration });
      await db.insert(chatExternalPrincipals).values({ id: a.principalId, companyId, provider: "microsoft-teams", providerAccountId: a.tenantId, externalId: a.aadObjectId });
      await db.insert(issueComments).values({ id: a.commentId, companyId, issueId: a.issueId, body: "Share", authorUserId: a.authorizedUserId });
      await db.insert(assets).values({ id: assetId, companyId, provider: "local_disk", objectKey: `test/${assetId}`, contentType: "text/plain", byteSize: bytes.length, sha256: a.sha256, originalFilename: "file.txt" });
      await db.insert(issueAttachments).values({ id: a.attachmentId, companyId, issueId: a.issueId, assetId, issueCommentId: a.commentId });
      await db.insert(chatPublications).values({ id: a.publicationId, companyId, endpointId: a.endpointId, conversationId: a.conversationId, issueId: a.issueId, commentId: a.commentId, idempotencyKey: `test:${a.publicationId}`, payload: { text: "Shared file.txt.", attachmentIds: [a.attachmentId] } });
      const postConsent = vi.fn(async () => ({ id: "card-1" }));
      const service = teamsFileTransferService(db, {
        authorize: async () => ({ ...a }), loadBytes: async () => Buffer.from(bytes), postConsent,
        postFileInfo: vi.fn(async () => ({ id: "fi-1" })),
        uploadRequest: vi.fn(async () => Response.json({ id: "item-1", name: "file.txt", size: bytes.length }, { status: 201 })),
      });
      const created = await service.issue(a, new Date(Date.now() + 60_000));
      const row = async () => (await db.select().from(chatTeamsFileTransfers).where(eq(chatTeamsFileTransfers.id, created.id)))[0]!;
      const process = () => service.process(companyId, created.id);
      return { postConsent, row, process };
    }

    it("held: the consent stage stays pending, the row is not touched and nothing is posted", async () => {
      const f = await teamsFixture();
      const before = await f.row();
      await holdFence();
      expect(await f.process()).toMatchObject({ phase: "consent_pending" });
      expect(await f.row()).toMatchObject({ phase: "consent_pending", attemptId: null, attemptExpiresAt: null, version: before.version });
      expect(f.postConsent).not.toHaveBeenCalled();
      // Released: the same pending stage is claimed by the existing worker.
      await openFence();
      expect(await f.process()).toMatchObject({ phase: "awaiting_consent" });
      expect(f.postConsent).toHaveBeenCalledTimes(1);
    });

    it("busy: an exclusive fence lock refuses without waiting and posts nothing", async () => {
      const f = await teamsFixture();
      const before = await f.row();
      await openFence();
      expect(await withExclusiveFenceLock(() => f.process())).toMatchObject({ phase: "consent_pending" });
      expect((await f.row()).version).toBe(before.version);
      expect(f.postConsent).not.toHaveBeenCalled();
    });

    it("control: an open fence claims the stage and posts the consent card once", async () => {
      const f = await teamsFixture();
      await openFence();
      expect(await f.process()).toMatchObject({ phase: "awaiting_consent" });
      expect(f.postConsent).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------- row i: Browser Use create
  describe("i: Browser Use session start", () => {
    async function browserFixture() {
      const companyId = await company("BU");
      const actor = { actorType: "user" as const, actorId: `user-${randomUUID()}` };
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: actor.actorId, membershipRole: "admin", status: "active" });
      const request = vi.fn(async (url: string, init: RequestInit) => {
        const p = new URL(url).pathname.replace("/api/v4", "");
        if (p === "/profiles") return Response.json({ items: [], totalItems: 0 });
        if (p === "/runs" && init.method === "POST") return Response.json({ id: randomUUID(), sessionId: randomUUID(), status: "running", model: "fixture" });
        throw new Error(`Unexpected fixture path ${p}`);
      });
      const access = toolAccessService(db, { remoteHttpRequest: request as never, remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }] } as never);
      const connection = await access.connectGalleryApp(companyId, { galleryKey: "browser-use-cloud", connectionMethodKey: "cloud-v4", credentialValues: { "credentials.apiKey": "bu_fixture_value" } } as never, actor as never);
      const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, connection.connectionId));
      const [agent] = await db.insert(agents).values({ companyId, name: "Browser agent", role: "engineer", adapterType: "process", adapterConfig: {} }).returning();
      await access.finishGalleryAppConnection(companyId, connection.connectionId, { enabledCatalogEntryIds: connection.catalog.map((t: { id: string }) => t.id), askFirstCatalogEntryIds: [], access: { agentIds: [agent!.id] } } as never, actor as never);
      const [issue] = await db.insert(issues).values({ companyId, title: "Browser task", assigneeAgentId: agent!.id }).returning();
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, invocationSource: "on_demand", status: "running", responsibleUserId: actor.actorId, contextSnapshot: { issueId: issue!.id } }).returning();
      const service = browserUseService(db, request as never);
      const binding = { companyId, agentId: agent!.id, issueId: issue!.id, runId: run!.id };
      const creates = () => request.mock.calls.filter(([url, init]) => String(url).endsWith("/runs") && init.method === "POST");
      const sessions = () => db.select().from(browserUseSessions).where(eq(browserUseSessions.companyId, companyId));
      const runs = () => db.select().from(browserUseRuns).where(eq(browserUseRuns.companyId, companyId));
      const start = (invocationId: string) => service.execute(binding as never, grant! as never, invocationId, "browser_start", { task: "Read" });
      return { start, creates, sessions, runs };
    }

    it("held: 409 before the session and run rows exist; no provider run is started", async () => {
      const f = await browserFixture();
      await holdFence();
      const invocationId = randomUUID();
      await expect(f.start(invocationId)).rejects.toMatchObject({ status: 409, details: { code: "upgrade_fence_held" } });
      expect(await f.sessions()).toHaveLength(0);
      expect(await f.runs()).toHaveLength(0);
      expect(f.creates()).toHaveLength(0);
      // Released: the same invocation is admitted.
      await openFence();
      await f.start(invocationId);
      expect(f.creates()).toHaveLength(1);
    });

    it("control: an open fence inserts the session and run and starts one provider run", async () => {
      const f = await browserFixture();
      await openFence();
      const invocationId = randomUUID();
      expect(await f.start(invocationId)).toMatchObject({ status: "running" });
      expect(await f.sessions()).toMatchObject([{ status: "running" }]);
      expect(await f.runs()).toMatchObject([{ invocationId, status: "running" }]);
      expect(f.creates()).toHaveLength(1);
    });
  });

  // ---------------------------------------------- row j: Dot runner reserve
  describe("j: Dot runner operation reserve", () => {
    async function dotFixture() {
      const companyId = await company("DR");
      const userId = `user-${randomUUID()}`, clientId = `client-${randomUUID()}`, sessionId = randomUUID();
      await db.insert(authUsers).values({ id: userId, name: "Dot operator", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
      const [agent] = await db.insert(agents).values({ companyId, name: "Dot", adapterType: "paperclip_runner", status: "active", adapterConfig: { provider: "openai_dot", allowUnmeteredProvider: true } }).returning();
      await db.insert(mcpOauthClients).values({ id: clientId, name: "Dedicated Dot", redirectUris: ["https://chatgpt.com/connector_platform/oauth/callback"] });
      const [grant] = await db.insert(mcpOauthGrants).values({ companyId, userId, clientId, resource: "https://paperclip.example/mcp/runner", purpose: "agent", agentId: agent!.id, scopes: ["paperclip:agent", "offline_access"] }).returning();
      const [binding] = await db.insert(dotAgentBindings).values({ companyId, agentId: agent!.id, operatorId: userId, grantId: grant!.id, status: "ready", readyAt: new Date() }).returning();
      const [issue] = await db.insert(issues).values({ companyId, title: "Dot work", status: "in_progress", assigneeAgentId: agent!.id }).returning();
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, status: "running", runtimeMode: "native", nativeSessionId: sessionId, nativeIssueId: issue!.id, invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId: issue!.id } }).returning();
      await db.update(issues).set({ executionRunId: run!.id }).where(eq(issues.id, issue!.id));
      await db.insert(nativeRunFinalizations).values({ runId: run!.id, companyId, issueId: issue!.id, phase: "observed", controllerGeneration: 1, leaseExpiresAt: new Date(Date.now() + 600_000) } as never);
      const [assignment] = await db.insert(dotRunnerAssignments).values({
        companyId, bindingId: binding!.id, bindingGeneration: binding!.generation, runId: run!.id, agentId: agent!.id,
        normalizedSessionId: sessionId, turnId: randomUUID(), controllerGeneration: 1, catalogDigest: "test", status: "offered", projection: {},
        acceptBy: new Date(Date.now() + 600_000), expiresAt: new Date(Date.now() + 7_200_000),
      } as never).returning();
      const principal = { grant: grant!, actor: { type: "agent", agentId: agent!.id, companyId }, company: { id: companyId, name: "", issuePrefix: "", status: "active" } } as unknown as McpPrincipal;
      const broker = dotRunnerBroker(db);
      const send = vi.fn(async (_op: unknown) => {});
      const snapshot = { companyId, agentId: agent!.id, bindingId: binding!.id, bindingGeneration: binding!.generation, acceptByUnixMs: 0, expiresAtUnixMs: 0 };
      const detach = await broker.port({ binding: { companyId, agentId: agent!.id, runId: run!.id }, provider: { binding: snapshot } } as never).attach(send as never, undefined, true);
      const ops = () => db.select().from(dotRunnerOperations).where(eq(dotRunnerOperations.assignmentId, assignment!.id));
      const assignmentRow = async () => (await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.id, assignment!.id)))[0]!;
      const operation = (requestId: string) => broker.operation(principal, assignment!.id, requestId, "accept", {});
      return { operation, send, detach, ops, assignmentRow };
    }

    it("held: a retryable held result before the operation row exists; nothing is forwarded", async () => {
      const f = await dotFixture();
      try {
        const before = await f.assignmentRow();
        await holdFence();
        expect(await f.operation(randomUUID())).toMatchObject({ outcome: "held", retryable: true, code: "upgrade_fence_held" });
        expect(await f.ops()).toHaveLength(0);
        expect(f.send).not.toHaveBeenCalled();
        expect(await f.assignmentRow()).toMatchObject({ status: before.status, controllerGeneration: before.controllerGeneration });
      } finally { await (f.detach as () => Promise<void> | void)(); }
    });

    it("control: an open fence reserves the operation and forwards it to the runner port", async () => {
      const f = await dotFixture();
      try {
        await openFence();
        const requestId = randomUUID();
        expect(await f.operation(requestId)).toMatchObject({ status: "pending", requestId });
        expect(await f.ops()).toMatchObject([{ requestId, status: "admitted" }]);
        expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ requestId, action: "accept" }));
      } finally { await (f.detach as () => Promise<void> | void)(); }
    });
  });

  // ------------------------------------------- row k: tool gateway execute
  describe("k: tool gateway plugin tool execution", () => {
    async function gatewayFixture() {
      const companyId = await company("TG");
      const [agent] = await db.insert(agents).values({ companyId, name: `Fence agent ${randomUUID()}`, role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} }).returning();
      const [issue] = await db.insert(issues).values({ companyId, title: "Fence tool", status: "in_progress", assigneeAgentId: agent!.id }).returning();
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, invocationSource: "assignment", status: "running", contextSnapshot: { issueId: issue!.id } }).returning();
      await db.insert(toolPolicies).values({ companyId, name: "Allow read fixture", policyType: "allow", selectors: { toolName: "fixture:read_status" } } as never);
      const calls: unknown[] = [];
      const dispatcher = {
        initialize: async () => {}, teardown: () => {},
        listToolsForAgent: () => [{ name: "fixture:read_status", displayName: "Read status", description: "fixture", parametersSchema: { type: "object" }, pluginId: "fixture-plugin" }],
        getTool: () => null,
        executeTool: async (name: string, parameters: unknown) => {
          calls.push({ name, parameters });
          return { pluginId: "fixture-plugin", toolName: "read_status", result: { ok: true } };
        },
        registerPluginTools: () => {}, unregisterPluginTools: () => {}, toolCount: () => 1,
        getRegistry: () => { throw new Error("not used"); },
      } as unknown as PluginToolDispatcher;
      const gateway = createToolGatewayService(db, { pluginToolDispatcher: dispatcher } as never);
      const context = { companyId, agentId: agent!.id, runId: run!.id };
      const call = () => gateway.executePluginTool({ actor: { type: "agent", ...context }, tool: "fixture:read_status", parameters: {}, runContext: context } as never);
      const invocations = () => db.select().from(toolInvocations).where(eq(toolInvocations.companyId, companyId));
      const allowed = () => db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "tool_gateway.call_allowed")));
      return { calls, call, invocations, allowed };
    }

    it("held: 409 before executing; the invocation stays authorized and the plugin is not called", async () => {
      const f = await gatewayFixture();
      await holdFence();
      await expect(f.call()).rejects.toMatchObject({ status: 409, reasonCode: "upgrade_fence_held", details: { retryable: true } });
      expect(await f.invocations()).toMatchObject([{ status: "authorized", startedAt: null }]);
      expect(f.calls).toEqual([]);
      expect(await f.allowed()).toEqual([]);
    });

    it("control: an open fence executes the invocation and calls the plugin once", async () => {
      const f = await gatewayFixture();
      await openFence();
      await expect(f.call()).resolves.toMatchObject({ pluginId: "fixture-plugin", toolName: "read_status" });
      expect(f.calls).toHaveLength(1);
      const [row] = await f.invocations();
      expect(row).toMatchObject({ status: "succeeded" });
      expect(row!.startedAt).not.toBeNull();
    });
  });
});
