import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  authUsers,
  budgetReservations,
  companies,
  companyMemberships,
  createDb,
  fastResponseRequests,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueQuestionResponseDeliveries,
  issueThreadInteractions,
  issues,
  mcpMutationReceipts,
  mcpOauthClients,
  mcpOauthGrants,
} from "@paperclipai/db";
import { createPublicMcpExecutor } from "../services/public-mcp/capabilities.js";
import type { PublicMcpOAuth } from "../services/public-mcp/oauth.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { enqueueFastResponse, fastResponseService } from "../services/fast-responses.js";
import { fastResponseReceipt, type FastResponseOutcome } from "../services/fast-response-provider.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { questionResponseDeliveryService } from "../services/question-response-delivery.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// FAC-797 / STA-21 stage 25: upgrade admission fence phase 2a, the effect
// reservation gate (admission-design r2 §2.4 rows a–l, §3.4). Each case drives
// the real writer against real embedded Postgres. A held fence must refuse
// before the reservation exists (nothing written, no outbound call) and leave
// the record in its waiting state; an open fence admits. Red on 118d3ebd,
// where no effect writer reads the fence.

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping upgrade fence effect tests on this host: ${support.reason ?? "unsupported environment"}`);
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

describeEmbedded("upgrade admission fence, phase 2a effect reservations", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let other: ReturnType<typeof createDb>;
  let home: string;
  beforeAll(async () => {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-fence-effects-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "fence-effects-fixture");
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "fence-effects-test-only-signing-value");
    temporary = await startEmbeddedPostgresTestDatabase("upgrade-fence-effects-");
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

  // ---------------------------------------------------------------- row a
  describe("a: public MCP mutation receipt", () => {
    async function mcpFixture() {
      const companyId = await company("MC");
      const userId = `user-${randomUUID()}`;
      const clientId = `client-${randomUUID()}`;
      await db.insert(authUsers).values({ id: userId, name: "Fence User", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(mcpOauthClients).values({ id: clientId, name: "Fence client", redirectUris: ["https://client.example/cb"] });
      const [grant] = await db.insert(mcpOauthGrants).values({ companyId, userId, clientId, resource: "https://paperclip.example/mcp/paperclip", scopes: ["paperclip:read", "paperclip:write"] }).returning();
      const principal = {
        grant: { id: grant!.id, userId, companyId, clientId, scopes: ["paperclip:read", "paperclip:write"] },
        actor: { type: "board", userId, memberships: [{ companyId, membershipRole: "owner" }] },
      };
      const oauth = { authenticate: async () => principal, config: { origin: "https://paperclip.example" } } as unknown as PublicMcpOAuth;
      const dispatch = vi.fn().mockResolvedValue({ id: randomUUID(), body: "ok" });
      const execute = createPublicMcpExecutor(db, oauth, dispatch);
      const args = { companyId, requestId: randomUUID(), taskId: randomUUID(), body: "fenced comment" };
      const receipts = () => db.select().from(mcpMutationReceipts).where(eq(mcpMutationReceipts.companyId, companyId));
      return { execute, dispatch, args, receipts };
    }

    it("a held fence returns a retryable held result before any receipt exists and dispatches nothing", async () => {
      const f = await mcpFixture();
      await holdFence();
      const result = await f.execute("token", "paperclip_add_comment", f.args);
      expect(result).toMatchObject({ outcome: "held", retryable: true, code: "upgrade_fence_held", requestId: f.args.requestId });
      expect(await f.receipts()).toHaveLength(0);
      expect(f.dispatch).not.toHaveBeenCalled();
      // The same request runs once the fence opens: no receipt blocked the retry.
      await openFence();
      await f.execute("token", "paperclip_add_comment", f.args);
      expect(await f.receipts()).toHaveLength(1);
      expect(f.dispatch).toHaveBeenCalledTimes(1);
    });

    it("a fence mutation holding the exclusive lock makes the reservation refuse busy without waiting", async () => {
      const f = await mcpFixture();
      await openFence();
      const started = Date.now();
      const result = await withExclusiveFenceLock(() => f.execute("token", "paperclip_add_comment", f.args));
      expect(Date.now() - started).toBeLessThan(4_000);
      expect(result).toMatchObject({ outcome: "held", code: "upgrade_fence_busy" });
      expect(await f.receipts()).toHaveLength(0);
      expect(f.dispatch).not.toHaveBeenCalled();
    });

    it("control: an open fence reserves the receipt and dispatches", async () => {
      const f = await mcpFixture();
      await openFence();
      await f.execute("token", "paperclip_add_comment", f.args);
      expect(await f.receipts()).toHaveLength(1);
      expect(f.dispatch).toHaveBeenCalledTimes(1);
    });
  });

  // ------------------------------------------------------------ rows b, c
  describe("b, c: runner workspace and call_api mutation receipts", () => {
    let server: Server;
    let apiUrl: string;
    const hits: string[] = [];
    beforeAll(async () => {
      server = createServer((req, res) => {
        hits.push(`${req.method} ${req.url}`);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: randomUUID(), body: "ok" }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      apiUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    });
    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    afterEach(() => { hits.length = 0; });

    async function runnerFixture() {
      const companyId = await company("RN");
      const agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
      const workspaceRoot = await realpath(await mkdtemp(path.join(home, "workspace-")));
      await db.insert(agents).values({ id: agentId, companyId, name: "Runner", role: "engineer", status: "active", adapterType: "paperclip_runner", adapterConfig: { provider: "openai_dot", dotWorkspaceAccess: true } });
      await db.insert(issues).values({ id: issueId, companyId, title: "Fenced work", status: "in_progress", assigneeAgentId: agentId });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId, invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId } });
      await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
      const authority = new PaperclipRunnerToolAuthority(db, {
        companyId, agentId, issueId, runId, workspaceRoot, workspaceBridge: true, apiToolsEnabled: true, apiUrl,
      } as never);
      const receipts = async () => {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        const result = (run?.resultJson ?? {}) as Record<string, Record<string, unknown> | undefined>;
        return { bridge: Object.keys(result.bridgeToolReceipts ?? {}), api: Object.keys(result.apiToolReceipts ?? {}) };
      };
      return { companyId, issueId, workspaceRoot, authority, receipts };
    }

    it("b: a held fence refuses workspace_write before the pending receipt; the file is not written", async () => {
      const f = await runnerFixture();
      await holdFence();
      const call = { tool: "workspace_write", callId: "write-1", arguments: { path: "fenced.txt", text: "hello", expectedSha256: null } };
      expect(await f.authority.execute(call)).toMatchObject({ outcome: "held", retryable: true, code: "upgrade_fence_held" });
      await expect(readFile(path.join(f.workspaceRoot, "fenced.txt"), "utf8")).rejects.toThrow();
      expect((await f.receipts()).bridge).toHaveLength(0);
    });

    it("b control: an open fence reserves the receipt and writes the file", async () => {
      const f = await runnerFixture();
      await openFence();
      const call = { tool: "workspace_write", callId: "write-1", arguments: { path: "fenced.txt", text: "hello", expectedSha256: null } };
      await f.authority.execute(call);
      expect(await readFile(path.join(f.workspaceRoot, "fenced.txt"), "utf8")).toBe("hello");
      expect((await f.receipts()).bridge).toHaveLength(1);
    });

    it("c: a held fence refuses call_api before the pending receipt and sends no HTTP request", async () => {
      const f = await runnerFixture();
      await holdFence();
      const call = { tool: "call_api", callId: "api-1", arguments: { operationId: "POST /api/issues/{id}/comments", pathParams: { id: f.issueId }, body: { body: "fenced" } } };
      expect(await f.authority.execute(call)).toMatchObject({ ok: false, outcome: "held", retryable: true, code: "upgrade_fence_held" });
      expect(hits).toEqual([]);
      expect((await f.receipts()).api).toHaveLength(0);
    });

    it("c control: an open fence reserves the receipt and dispatches the HTTP request", async () => {
      const f = await runnerFixture();
      await openFence();
      const call = { tool: "call_api", callId: "api-1", arguments: { operationId: "POST /api/issues/{id}/comments", pathParams: { id: f.issueId }, body: { body: "fenced" } } };
      const result = await f.authority.execute(call);
      expect([result, hits]).toEqual([expect.anything(), [`POST /api/issues/${f.issueId}/comments`]]);
      expect((await f.receipts()).api).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------- row d
  describe("d: fast response claim", () => {
    const outcome: FastResponseOutcome = {
      text: "I'll check the settings panel.",
      receipt: fastResponseReceipt({ usage: { inputTokens: 8, outputTokens: 4 }, response: { id: "response-fence", body: { usage: { cost: 0.00001 } } } }),
    };
    async function fastFixture() {
      await instanceSettingsService(db).updateExperimental({ enableFastResponses: true });
      const companyId = await company("FR");
      const agentId = randomUUID(), issueId = randomUUID();
      await db.insert(agents).values({ id: agentId, companyId, name: "Alex", adapterType: "codex_local" });
      await db.insert(companyMemberships).values({ companyId, principalId: "alice", principalType: "user", status: "active", membershipRole: "owner" });
      const binding = await aiConnectionService(db).save(companyId, "alice", {
        provider: "openrouter", method: "api_key", name: "Fast key", ownership: "shared", apiKey: "fixture-key", agentIds: [], allAgents: true,
      }, "fixture-key");
      const provider = vi.fn().mockResolvedValue(structuredClone(outcome));
      const service = fastResponseService(db, { provider });
      await service.configure(companyId, "alice", { connectionId: binding.connectionId, grantId: binding.grantId, enabled: true, model: "openai/gpt-oss-120b", allowSponsored: true });
      await db.insert(issues).values({ id: issueId, companyId, title: "Settings panel", status: "in_progress", assigneeAgentId: agentId });
      const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorUserId: "alice", body: "Fix the border" }).returning();
      await db.transaction((tx) => enqueueFastResponse(tx as unknown as typeof db, {
        companyId, agentId, issueId, responsibleUserId: "alice", sourceCommentId: comment!.id, sourceKey: `comment:${comment!.id}`, acceptedAt: comment!.createdAt,
      }));
      const request = async () => (await db.select().from(fastResponseRequests).where(eq(fastResponseRequests.companyId, companyId)))[0]!;
      const reservations = () => db.select().from(budgetReservations).where(eq(budgetReservations.companyId, companyId));
      return { service, provider, request, reservations };
    }

    it("a held fence refuses the claim: the request stays pending, no reservation, no provider call", async () => {
      const f = await fastFixture();
      await holdFence();
      expect(await f.service.process(await f.request())).toMatchObject({ status: "unavailable", reason: "upgrade_fence_held" });
      expect(await f.request()).toMatchObject({ status: "pending", startedAt: null, errorCode: null });
      expect(await f.reservations()).toHaveLength(0);
      expect(f.provider).not.toHaveBeenCalled();
      // Released: the same pending request is admitted by the existing worker.
      await openFence();
      await f.service.process(await f.request());
      expect(f.provider).toHaveBeenCalledTimes(1);
    });

    it("control: an open fence claims the request and calls the provider", async () => {
      const f = await fastFixture();
      await openFence();
      await f.service.process(await f.request());
      expect(f.provider).toHaveBeenCalledTimes(1);
      expect((await f.request()).status).not.toBe("pending");
    });
  });

  // ---------------------------------------------------------------- row e
  describe("e: question-response delivery claim", () => {
    async function questionFixture() {
      const companyId = await company("QR");
      const issueId = randomUUID();
      await db.insert(issues).values({ id: issueId, companyId, title: "Question", status: "in_progress" });
      const [interaction] = await db.insert(issueThreadInteractions).values({
        companyId, issueId, kind: "ask_user_questions", status: "answered",
        payload: { version: 1, questions: [{ id: "q1", prompt: "Proceed?", selectionMode: "single", options: [{ id: "yes", label: "Yes" }] }] } as never,
      }).returning();
      const [delivery] = await db.insert(issueQuestionResponseDeliveries).values({
        companyId, issueId, interactionId: interaction!.id, correlationId: randomUUID(), payloadSha256: "c".repeat(64),
      }).returning();
      const service = questionResponseDeliveryService(db, { heartbeat: {} as never });
      const row = async () => (await db.select().from(issueQuestionResponseDeliveries).where(eq(issueQuestionResponseDeliveries.id, delivery!.id)))[0]!;
      return { service, interactionId: interaction!.id, row };
    }

    it("a held fence refuses the delivery claim; the delivery stays pending with no attempt", async () => {
      const f = await questionFixture();
      await holdFence();
      expect(await f.service.deliver(f.interactionId)).toBeNull();
      expect(await f.row()).toMatchObject({ status: "pending", attemptCount: 0, lastAttemptAt: null });
    });

    it("control: an open fence claims the delivery (one attempt recorded)", async () => {
      const f = await questionFixture();
      await openFence();
      await f.service.deliver(f.interactionId).catch(() => null);
      expect((await f.row()).attemptCount).toBe(1);
    });
  });
});

// N7 (admission-design r2 §2.4, r8 §1 phase 2): every effect reservation write
// is pinned, and the fence check must sit in the same transaction callback,
// before the write. Rows f–k have no behaviour case in this stage (their
// service harnesses need provider fixtures); this structural pin and the
// writer-set counts below are their evidence, and a removed gate fails here.
describe("upgrade admission fence effect reservations (structural, N7)", () => {
  const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const sites: Array<{ row: string; file: string; boundary: string; write: string }> = [
    { row: "a", file: "services/public-mcp/capabilities.ts", boundary: "public_mcp.mutation", write: "tx.insert(mcpMutationReceipts)" },
    { row: "b", file: "services/native-runtime/paperclip-runner-tool-authority.ts", boundary: "runner.workspace_mutation", write: "receipts[key] = { digest, tool: call.tool, state: \"pending\" };" },
    { row: "c", file: "services/native-runtime/paperclip-runner-tool-authority.ts", boundary: "runner.call_api", write: "receipts[key] = { digest, operationId: operation.operationId, state: \"pending\" };" },
    { row: "d", file: "services/fast-responses.ts", boundary: "fast_response.claim", write: "            .update(fastResponseRequests)\n            .set({\n              status: \"running\"," },
    { row: "e", file: "services/question-response-delivery.ts", boundary: "question_delivery.claim", write: "        .set({\n          status: \"delivering\"," },
    { row: "f", file: "services/chat-channels.ts", boundary: "chat_publication.send", write: "        .set({\n          state: \"streaming\"," },
    { row: "f", file: "services/email-channels.ts", boundary: "chat_publication.send", write: "          .set({ state: \"streaming\", attempts: pub.attempts + 1 })" },
    { row: "f", file: "services/chat-teams-file-transfers.ts", boundary: "chat_publication.send", write: "            ? \"consent_sending\"" },
    { row: "g", file: "services/chat-channels.ts", boundary: "chat_action.dispatch", write: "              await notifyChatActionWork(tx, \"provider_effect\");\n              const [transportClaim] = await tx" },
    { row: "g", file: "services/chat-channels.ts", boundary: "chat_action.dispatch", write: "      await notifyChatActionWork(tx, \"receipt_reaction\");\n      const rows = await tx" },
    { row: "g", file: "services/chat-channels.ts", boundary: "chat_action.dispatch", write: "          result: { attempts: attempt, providerConfirmed }," },
    { row: "g", file: "services/chat-channels.ts", boundary: "chat_action.dispatch", write: "          status: \"validating\",\n          result: { attemptCount: attempt }," },
    { row: "g", file: "services/chat-channels.ts", boundary: "chat_action.dispatch", write: "                status: \"resolving\",\n                result: {\n                  attemptCount: attempt," },
    { row: "g", file: "services/chat-channels.ts", boundary: "chat_action.dispatch", write: "                code: \"slash_task_retry_requested\",\n                attemptCount: retryAttempt," },
    { row: "g", file: "services/chat-channels.ts", boundary: "chat_action.dispatch", write: "                      kind: \"github_webhook_recovery\"," },
    { row: "g", file: "services/chat-channels.ts", boundary: "chat_action.dispatch", write: "            await notifyChatActionWork(tx, \"slack_session_sync\");\n            const claimed = await tx" },
    { row: "g", file: "services/connectors/slack-writes.ts", boundary: "chat_action.dispatch", write: "      .set({ status: \"processing\", updatedAt: new Date() })" },
    { row: "g", file: "services/connectors/slack-retry.ts", boundary: "chat_action.dispatch", write: "        status: \"executing\"," },
    { row: "g", file: "services/voice/speko-tool-setup.ts", boundary: "helper:assertSpekoSetupAdmitted", write: "kind: \"speko_tool_setup\"" },
    { row: "g", file: "services/voice/speko-tool-setup.ts", boundary: "helper:assertSpekoSetupAdmitted", write: "kind: \"speko_lifecycle_setup\", providerActionId: actionId" },
    { row: "h", file: "services/voice/voice-reply-push.ts", boundary: "voice_reply.push", write: "const values = {status: \"dispatching\"" },
    { row: "i", file: "services/browser-use.ts", boundary: "browser_use.create", write: "      await tx.insert(runs).values({" },
    { row: "j", file: "services/dot-runner-broker.ts", boundary: "dot_runner.reserve", write: "const [reserved] = await tx.insert(operations).values(" },
    { row: "k", file: "services/tool-gateway.ts", boundary: "helper:assertToolExecutionAdmitted", write: "      return tx\n        .update(toolActionRequests)\n        .set({ status: \"executing\", updatedAt: new Date() })" },
    { row: "k", file: "services/tool-gateway.ts", boundary: "helper:assertToolExecutionAdmitted", write: "        .where(eq(toolInvocations.id, args.invocationId));\n    });" },
    { row: "k", file: "services/tool-gateway.ts", boundary: "helper:assertToolExecutionAdmitted", write: "          return tx\n            .update(toolActionRequests)\n            .set({\n              status: \"executing\",\n              resolvedByAgentId: session.agentId," },
    { row: "k", file: "services/tool-gateway.ts", boundary: "helper:assertToolExecutionAdmitted", write: "          await tx\n            .update(toolInvocations)\n            .set({\n              status: \"executing\",\n              startedAt: new Date()," },
    { row: "k", file: "services/tool-gateway.ts", boundary: "helper:assertToolExecutionAdmitted", write: "        await tx\n          .update(toolInvocations)\n          .set({\n            status: \"executing\",\n            startedAt: new Date()," }
  ];

  it("every pinned reservation write is preceded by the fence gate in its own transaction", () => {
    const problems: string[] = [];
    for (const site of sites) {
      const source = read(site.file);
      const at = source.indexOf(site.write);
      if (at < 0 || source.indexOf(site.write, at + 1) >= 0) {
        problems.push(`${site.row} ${site.file}: write anchor missing or not unique`);
        continue;
      }
      const transaction = source.lastIndexOf(".transaction(", at);
      const scope = transaction < 0 ? "" : source.slice(transaction, at);
      const gate = site.boundary.startsWith("helper:")
        ? `${site.boundary.slice("helper:".length)}(`
        : `admitEffectReservationUnderUpgradeFence(tx as unknown as Db, "${site.boundary}")`;
      if (!scope.includes(gate)) problems.push(`${site.row} ${site.file}: no ${gate} before the write in its transaction`);
    }
    expect(problems).toEqual([]);
  });

  it("the helper gates bind their boundary", () => {
    expect(read("services/tool-gateway.ts")).toContain('admitEffectReservationUnderUpgradeFence(tx, "tool_gateway.execute")');
    expect(read("services/voice/speko-tool-setup.ts")).toContain('admitEffectReservationUnderUpgradeFence(tx, "chat_action.dispatch")');
  });

  it("the set of in-flight effect writers is pinned (N7 writer-set scan)", () => {
    const root = new URL("../", import.meta.url);
    const patterns = [
      'state: "streaming"', 'status: "dispatching"', 'status: "executing"', 'status: "delivering"', 'status: "resolving"',
      "insert(mcpMutationReceipts)", "insert(operations)", "insert(runs)", 'status: "processing"',
    ];
    const found: Record<string, Record<string, number>> = {};
    const walk = (dir: URL) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
        if (entry.isDirectory()) { walk(child); continue; }
        if (!entry.name.endsWith(".ts") || entry.name.includes(".test.") || entry.name.includes("test-fixture")) continue;
        const source = readFileSync(child, "utf8");
        const file = child.pathname.slice(root.pathname.length);
        for (const pattern of patterns) {
          if (pattern === 'status: "processing"' && !source.includes("chatActions")) continue;
          const count = source.split(pattern).length - 1;
          if (count) (found[pattern] ??= {})[file] = count;
        }
      }
    };
    walk(root);
    // Each count is the gated reservation writes above plus writes classified
    // as not admission (stage-25 receipt and admission-design revision 9):
    // follow-on writes inside an already admitted attempt, Stop/cancel,
    // read-only provider lookups, inbound or internal-only work, a provider's
    // synchronous interaction reply, completed records and inert legacy rows.
    expect(found).toEqual({
      'state: "streaming"': { "services/chat-channels.ts": 1, "services/email-channels.ts": 1 },
      'status: "dispatching"': { "services/voice/voice-reply-push.ts": 1 },
      'status: "executing"': { "services/tool-gateway.ts": 11, "services/connectors/slack-retry.ts": 1 },
      'status: "delivering"': {
        "services/question-response-delivery.ts": 1, "services/decision-retention.ts": 1,
        "services/native-runtime/native-codex-runner.ts": 1,
      },
      'status: "resolving"': { "services/chat-channels.ts": 2 },
      "insert(mcpMutationReceipts)": { "services/public-mcp/capabilities.ts": 1 },
      "insert(operations)": { "services/dot-runner-broker.ts": 2 },
      "insert(runs)": { "services/browser-use.ts": 1 },
      'status: "processing"': {
        "services/chat-channels.ts": 17, "services/chat-question-forms.ts": 1,
        "services/voice/speko-tool-setup.ts": 3, "services/connectors/slack-writes.ts": 1,
      },
    });
  });
});
