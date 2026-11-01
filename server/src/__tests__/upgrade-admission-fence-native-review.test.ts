import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, instanceSettings, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// FAC-797 / STA-21 stage 23: the native review claim (claim-2) is gated by the
// upgrade admission fence before its execution lock or claim is written. The
// review-assignment validation is stubbed to "valid" so the case isolates the
// fence: on c541ff6b the claim proceeds under a held fence.
vi.mock("../services/native-runtime/native-review-participant.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-review-participant.js")>();
  return { ...actual, claimNativeReviewExecutionLock: vi.fn(async () => true) };
});

const { claimQueuedNativeReviewRun } = await import("../services/native-runtime/native-review-dispatch.js");
type FenceModule = typeof import("../services/upgrade-admission-fence.js");
const fence = await import("../services/upgrade-admission-fence.js").catch(() => null) as FenceModule | null;

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;

const FENCE_KEY = "upgrade-admission-fence/v1";
const state = (phase: string, extra: Record<string, unknown> = {}) => ({
  version: 1, epoch: 2, phase, initializedBy: "fresh_install", initializationId: randomUUID(), initializedAt: new Date().toISOString(),
  identity: null, owner: null, heldUntil: null, leaseUntil: null, reason: null, candidate: null, history: [], ...extra,
});

describeEmbedded("upgrade admission fence: native review claim", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("upgrade-fence-native-review-");
    db = createDb(temporary.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });
  afterEach(() => fence?.configureUpgradeAdmissionFenceMode("test_absent_open"));

  async function setFence(general: unknown | null) {
    await db.delete(instanceSettings).where(eq(instanceSettings.singletonKey, FENCE_KEY));
    if (general !== null) await db.insert(instanceSettings).values({ singletonKey: FENCE_KEY, general: general as Record<string, unknown> });
  }

  async function reviewRun() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), wakeId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Review fence", issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Reviewer", role: "engineer", status: "idle", adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Reviewed source", status: "in_review" });
    const contextSnapshot = { issueId, nativeReviewInteractionId: randomUUID(), nativeReviewDecisionId: randomUUID() };
    await db.insert(agentWakeupRequests).values({
      id: wakeId, companyId, agentId, source: "automation", triggerDetail: "system", reason: "native_review", status: "queued", runId,
    });
    const [run] = await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, invocationSource: "automation", status: "queued", runtimeMode: "native",
      wakeupRequestId: wakeId, contextSnapshot,
    }).returning();
    const read = () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then(rows => rows[0]!);
    const wake = () => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)).then(rows => rows[0]!);
    const claim = () => claimQueuedNativeReviewRun(db, { run: run!, agentNameKey: "reviewer", claimedAt: new Date(), claimValues: {} });
    return { read, wake, claim };
  }

  it("control: an open fence admits the native review claim", async () => {
    await setFence(state("open"));
    const f = await reviewRun();
    expect((await f.claim())?.status).toBe("running");
    expect((await f.wake()).status).toBe("claimed");
  });

  it.each([
    ["held", state("held", { owner: { tokenSha256: "b".repeat(64), actor: { type: "user", id: "o" }, heldAt: new Date().toISOString() }, heldUntil: new Date(Date.now() + 3600_000).toISOString() })],
    ["stopped_for_owner", state("stopped_for_owner")],
  ])("a %s fence refuses the native review claim and writes nothing", async (_phase, general) => {
    await setFence(general);
    const f = await reviewRun();
    expect(await f.claim()).toBeNull();
    expect((await f.read()).status).toBe("queued");
    expect((await f.wake()).status).toBe("queued");
  });

  it("an absent row refuses in production mode (existing instance stops for its owner)", async () => {
    await setFence(null);
    fence?.configureUpgradeAdmissionFenceMode("required");
    const f = await reviewRun();
    expect((await f.claim())?.status ?? null).toBeNull();
    expect((await f.read()).status).toBe("queued");
  });
});
