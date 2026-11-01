import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { companies, instanceSettings, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../middleware/logger.js";
import { persistActivity, publishActivity, type ActivityPublication } from "./activity-log.js";

// FAC-797 guarded-upgrade admission fence, implementation phase 1 (STA-21
// stage 23, admission-design revisions 2/3/6). One permanent keyed
// `instance_settings` row holds the fence state; one fixed transaction-scoped
// advisory lock serializes every gated run claim and, since phase 2a (stage
// 25), every effect reservation (shared, non-waiting) against every fence
// mutation (exclusive). No DDL. The activation inventory, the settlement
// resolver, the updater and the bootstrap are later phases.

export const UPGRADE_ADMISSION_FENCE_KEY = "upgrade-admission-fence/v1";
export const UPGRADE_BOOTSTRAP_EPISODE_KEY = "upgrade-bootstrap-episode/v1";

/**
 * Two-key advisory lock (class, object). The two-int4 space is distinct from
 * the single-bigint `hashtextextended` keys used elsewhere; a chance collision
 * with another two-key user only costs a refused claim or extra waiting.
 */
export const UPGRADE_FENCE_LOCK = { classId: 0x50435546, objectId: 1 } as const;

export const UPGRADE_FENCE_PHASES = ["open", "held", "activating", "verifying", "stopped_for_owner"] as const;
export type UpgradeFencePhase = (typeof UPGRADE_FENCE_PHASES)[number];

export const UPGRADE_FENCE_MIN_TTL_SECONDS = 60;
export const UPGRADE_FENCE_MAX_TTL_SECONDS = 24 * 60 * 60;
export const UPGRADE_FENCE_DEFAULT_TTL_SECONDS = 30 * 60;
const HISTORY_LIMIT = 50;
const MUTATION_LOCK_TIMEOUT = "5s";

/** Run-claim writers that move a heartbeat run into `running`. */
export type UpgradeFenceClaimBoundary =
  | "queue.queued_comment_claim"
  | "queue.claim"
  | "native_review.claim"
  | "native_session.replacement_turn"
  | "status_decision.replacement_turn"
  | "native_restart_recovery.claim"
  | "native_finalization.reopen"
  | "native_workspace_export.recovery"
  | "native_workspace_export.retry";

/**
 * Effect-reservation writers (admission-design r2 §2.4 rows a–l): the durable
 * write that marks a new outbound effect or provider send as in flight. A
 * refusal writes nothing and starts no outbound effect; the record stays in
 * its waiting state and the existing worker retries after release.
 */
export type UpgradeFenceEffectBoundary =
  | "public_mcp.mutation"
  | "runner.workspace_mutation"
  | "runner.call_api"
  | "fast_response.claim"
  | "question_delivery.claim"
  | "chat_publication.send"
  | "chat_action.dispatch"
  | "voice_reply.push"
  | "browser_use.create"
  | "dot_runner.reserve"
  | "tool_gateway.execute";
// Row l (decision, status-decision and connection-event effects) has no
// reservation: those effects settle inside one transaction or are inbound.

export type UpgradeFenceBoundary = UpgradeFenceClaimBoundary | UpgradeFenceEffectBoundary;

/**
 * `required`: an absent row refuses (production; the only default).
 * `test_absent_open`: an absent row admits, for test harnesses that never boot
 * a server. Only a test setup file may select it; production code never does.
 */
export type UpgradeFenceMode = "required" | "test_absent_open";
let fenceMode: UpgradeFenceMode = "required";

export function configureUpgradeAdmissionFenceMode(mode: UpgradeFenceMode) {
  fenceMode = mode;
}

export function getUpgradeAdmissionFenceMode(): UpgradeFenceMode {
  return fenceMode;
}

export type UpgradeFenceActor = { type: string; id: string | null };

/** Who an `activity_log` row attributes a fence transition to. */
export type UpgradeFenceActivityActor = {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
  agentApiKeyId?: string | null;
};

/** An expiry is committed by whichever caller observes it; it is never the caller's own act. */
export const UPGRADE_FENCE_EXPIRY_ACTOR: UpgradeFenceActivityActor = {
  actorType: "system",
  actorId: "upgrade-fence-expiry",
};

export type UpgradeFenceTransition = {
  from: UpgradeFencePhase;
  to: UpgradeFencePhase;
  epoch: number;
  reason: string;
  actor: UpgradeFenceActor | null;
  at: string;
  note?: string;
};

export type UpgradeFenceState = {
  version: 1;
  epoch: number;
  phase: UpgradeFencePhase;
  initializedBy: "fresh_install" | "bootstrap";
  initializationId: string;
  initializedAt: string;
  identity: Record<string, unknown> | null;
  owner: { tokenSha256: string; actor: UpgradeFenceActor; heldAt: string } | null;
  heldUntil: string | null;
  leaseUntil: string | null;
  reason: string | null;
  candidate: Record<string, unknown> | null;
  history: UpgradeFenceTransition[];
};

export type ParsedUpgradeFence =
  | { kind: "absent" }
  | { kind: "unreadable"; detail: string }
  | { kind: "valid"; state: UpgradeFenceState };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** Malformed, unknown-version or unknown-phase state is never admitted. */
export function parseUpgradeFenceGeneral(general: unknown): ParsedUpgradeFence {
  if (!isRecord(general)) return { kind: "unreadable", detail: "state_not_object" };
  if (general.version !== 1) return { kind: "unreadable", detail: "unsupported_version" };
  const epoch = general.epoch;
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0)
    return { kind: "unreadable", detail: "invalid_epoch" };
  const phase = general.phase;
  if (typeof phase !== "string" || !(UPGRADE_FENCE_PHASES as readonly string[]).includes(phase))
    return { kind: "unreadable", detail: "unknown_phase" };
  if (general.initializedBy !== "fresh_install" && general.initializedBy !== "bootstrap")
    return { kind: "unreadable", detail: "invalid_initializer" };
  if (phase === "held") {
    const owner = general.owner;
    if (!isRecord(owner) || typeof owner.tokenSha256 !== "string" || !/^[0-9a-f]{64}$/.test(owner.tokenSha256))
      return { kind: "unreadable", detail: "held_without_owner" };
    if (!isTimestamp(general.heldUntil)) return { kind: "unreadable", detail: "held_without_expiry" };
  }
  if ((phase === "activating" || phase === "verifying") && !isTimestamp(general.leaseUntil))
    return { kind: "unreadable", detail: "lease_without_expiry" };
  return {
    kind: "valid",
    state: {
      version: 1,
      epoch,
      phase: phase as UpgradeFencePhase,
      initializedBy: general.initializedBy,
      initializationId: typeof general.initializationId === "string" ? general.initializationId : "",
      initializedAt: typeof general.initializedAt === "string" ? general.initializedAt : "",
      identity: isRecord(general.identity) ? general.identity : null,
      owner: isRecord(general.owner) && typeof general.owner.tokenSha256 === "string"
        ? general.owner as UpgradeFenceState["owner"]
        : null,
      heldUntil: isTimestamp(general.heldUntil) ? general.heldUntil : null,
      leaseUntil: isTimestamp(general.leaseUntil) ? general.leaseUntil : null,
      reason: typeof general.reason === "string" ? general.reason : null,
      candidate: isRecord(general.candidate) ? general.candidate : null,
      history: Array.isArray(general.history) ? general.history as UpgradeFenceTransition[] : [],
    },
  };
}

/**
 * Phase-aware expiry (admission-design r2 §3.7, r3 §3.8 / P3), evaluated at
 * database time. `held` reopens (nothing was switched); `activating` and
 * `verifying` stop for the owner; `open` and `stopped_for_owner` never move.
 */
export function expireUpgradeFenceState(
  state: UpgradeFenceState,
  nowMs: number,
): { state: UpgradeFenceState; transition: UpgradeFenceTransition | null } {
  const at = new Date(nowMs).toISOString();
  const expired = (until: string | null) => until !== null && Date.parse(until) < nowMs;
  let to: UpgradeFencePhase | null = null;
  let reason = "";
  if (state.phase === "held" && expired(state.heldUntil)) {
    to = "open";
    reason = "expired_before_activation";
  } else if (state.phase === "activating" && expired(state.leaseUntil)) {
    to = "stopped_for_owner";
    reason = "activation_lease_expired";
  } else if (state.phase === "verifying" && expired(state.leaseUntil)) {
    to = "stopped_for_owner";
    reason = "verification_lease_expired";
  }
  if (!to) return { state, transition: null };
  const transition: UpgradeFenceTransition = { from: state.phase, to, epoch: state.epoch, reason, actor: null, at };
  return {
    transition,
    state: withTransition({
      ...state,
      phase: to,
      reason,
      ...(to === "open" ? { owner: null, heldUntil: null, candidate: null } : {}),
    }, transition),
  };
}

function withTransition(state: UpgradeFenceState, transition: UpgradeFenceTransition): UpgradeFenceState {
  return { ...state, history: [...state.history, transition].slice(-HISTORY_LIMIT) };
}

export function hashUpgradeFenceToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function tokenMatches(token: string, expectedSha256: string) {
  const actual = Buffer.from(hashUpgradeFenceToken(token), "hex");
  const expected = Buffer.from(expectedSha256, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

type Rows = Array<Record<string, unknown>>;

async function execRows(db: Db, query: ReturnType<typeof sql>): Promise<Rows> {
  return (await db.execute(query)) as unknown as Rows;
}

async function readFenceRow(db: Db): Promise<ParsedUpgradeFence> {
  const [row] = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, UPGRADE_ADMISSION_FENCE_KEY))
    .limit(1);
  if (!row) return { kind: "absent" };
  return parseUpgradeFenceGeneral(row.general);
}

export type UpgradeFenceRefusalCode =
  | "upgrade_fence_busy"
  | "upgrade_fence_held"
  | "upgrade_fence_missing"
  | "upgrade_fence_unreadable"
  | "upgrade_fence_isolation";

export type UpgradeFenceAdmission =
  | { admitted: true; phase: "open" | "absent_test_open" }
  | { admitted: false; code: UpgradeFenceRefusalCode; phase: UpgradeFencePhase | null; boundary: UpgradeFenceBoundary };

/** Thrown where a gated writer must roll back writes it already made. */
export class UpgradeFenceRefusal extends Error {
  readonly code: UpgradeFenceRefusalCode;
  readonly phase: UpgradeFencePhase | null;
  readonly boundary: UpgradeFenceBoundary;
  constructor(refusal: Extract<UpgradeFenceAdmission, { admitted: false }>) {
    super(`Upgrade admission fence refused ${refusal.boundary}: ${refusal.code}`);
    this.name = "UpgradeFenceRefusal";
    this.code = refusal.code;
    this.phase = refusal.phase;
    this.boundary = refusal.boundary;
  }
}

export function isUpgradeFenceRefusal(error: unknown): error is UpgradeFenceRefusal {
  return error instanceof UpgradeFenceRefusal;
}

/**
 * The shared gate. Call inside the writer's own transaction, before the write
 * that claims a run or reserves an outbound effect: shared non-waiting fence
 * lock, then the fence row in a later statement at READ COMMITTED. Anything
 * other than an `open` row (or an absent row in test mode) refuses; an expired
 * `held` row still refuses until a fence mutation commits its expiry. Never
 * writes.
 */
async function admitUnderUpgradeFence(tx: Db, boundary: UpgradeFenceBoundary): Promise<UpgradeFenceAdmission> {
  const [isolation] = await execRows(tx, sql`select current_setting('transaction_isolation') as level`);
  if (isolation?.level !== "read committed")
    return { admitted: false, code: "upgrade_fence_isolation", phase: null, boundary };
  const [lock] = await execRows(
    tx,
    sql`select pg_try_advisory_xact_lock_shared(${UPGRADE_FENCE_LOCK.classId}::int4, ${UPGRADE_FENCE_LOCK.objectId}::int4) as acquired`,
  );
  if (lock?.acquired !== true) return { admitted: false, code: "upgrade_fence_busy", phase: null, boundary };
  const fence = await readFenceRow(tx);
  if (fence.kind === "absent") {
    return fenceMode === "test_absent_open"
      ? { admitted: true, phase: "absent_test_open" }
      : { admitted: false, code: "upgrade_fence_missing", phase: "stopped_for_owner", boundary };
  }
  if (fence.kind === "unreadable")
    return { admitted: false, code: "upgrade_fence_unreadable", phase: "stopped_for_owner", boundary };
  if (fence.state.phase !== "open")
    return { admitted: false, code: "upgrade_fence_held", phase: fence.state.phase, boundary };
  return { admitted: true, phase: "open" };
}

/** The run-claim gate (phase 1). */
export async function admitRunClaimUnderUpgradeFence(
  tx: Db,
  boundary: UpgradeFenceClaimBoundary,
): Promise<UpgradeFenceAdmission> {
  return admitUnderUpgradeFence(tx, boundary);
}

/** Same gate for writers whose earlier writes in the transaction must roll back. */
export async function assertRunClaimUnderUpgradeFence(tx: Db, boundary: UpgradeFenceClaimBoundary) {
  const admission = await admitUnderUpgradeFence(tx, boundary);
  if (!admission.admitted) throw new UpgradeFenceRefusal(admission);
}

/** The effect-reservation gate (phase 2a, r2 §2.4 rows a–l). */
export async function admitEffectReservationUnderUpgradeFence(
  tx: Db,
  boundary: UpgradeFenceEffectBoundary,
): Promise<UpgradeFenceAdmission> {
  return admitUnderUpgradeFence(tx, boundary);
}

/** Effect gate for writers whose earlier writes in the transaction must roll back. */
export async function assertEffectReservationUnderUpgradeFence(tx: Db, boundary: UpgradeFenceEffectBoundary) {
  const admission = await admitUnderUpgradeFence(tx, boundary);
  if (!admission.admitted) throw new UpgradeFenceRefusal(admission);
}

/**
 * The structured result a tool-facing writer returns instead of reserving
 * while the fence refuses. No receipt exists, so no unknown outcome is
 * created; the same request may be retried after the fence opens.
 */
export function upgradeFenceHeldResult(refusal: { code: UpgradeFenceRefusalCode }) {
  return {
    outcome: "held" as const,
    retryable: true as const,
    code: refusal.code,
    message:
      "Paperclip is holding new effects for a maintenance upgrade. Nothing was executed or recorded for this request. Retry the same request later.",
  };
}

export type UpgradeFenceMutationErrorCode =
  | "upgrade_fence_busy"
  | "fence_row_missing"
  | "fence_row_unreadable"
  | "fence_init_requires_bootstrap"
  | "upgrade_fence_held"
  | "upgrade_fence_not_holdable"
  | "upgrade_fence_not_abortable"
  | "upgrade_fence_stale_owner"
  | "upgrade_fence_invalid_ttl";

export class UpgradeFenceMutationError extends Error {
  readonly code: UpgradeFenceMutationErrorCode;
  readonly phase: UpgradeFencePhase | null;
  constructor(code: UpgradeFenceMutationErrorCode, message: string, phase: UpgradeFencePhase | null = null) {
    super(message);
    this.name = "UpgradeFenceMutationError";
    this.code = code;
    this.phase = phase;
  }
}

export type UpgradeFenceStatus = {
  key: typeof UPGRADE_ADMISSION_FENCE_KEY;
  present: boolean;
  readable: boolean;
  /** Effective phase: an absent or unreadable row is `stopped_for_owner`. */
  phase: UpgradeFencePhase;
  reason: string | null;
  epoch: number | null;
  heldUntil: string | null;
  leaseUntil: string | null;
  /** True when a lease has passed at database time but no mutation has committed its expiry yet. */
  expiryPending: boolean;
  owner: { actor: UpgradeFenceActor; heldAt: string } | null;
  candidate: Record<string, unknown> | null;
  initializedBy: string | null;
  databaseTime: string;
  admitsRunClaims: boolean;
};

export function upgradeFenceActivityAction(transition: UpgradeFenceTransition) {
  if (transition.to === "held") return "instance.upgrade_fence.held";
  if (transition.reason === "aborted_by_owner") return "instance.upgrade_fence.aborted";
  return "instance.upgrade_fence.expired";
}

/**
 * STA-22 R16: every committed fence transition (hold, abort, and expiry from
 * any caller) writes its `activity_log` rows in the transition's own
 * transaction. A failed audit write throws, so the fence state does not commit.
 * Live events are only collected here and published after commit.
 */
async function auditFenceTransition(
  tx: Db,
  transition: UpgradeFenceTransition,
  actor: UpgradeFenceActivityActor,
  publications: ActivityPublication[],
) {
  const companyRows = await tx.select({ id: companies.id }).from(companies);
  for (const { id: companyId } of companyRows) {
    const { publication } = await persistActivity(tx, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      agentApiKeyId: actor.agentApiKeyId ?? null,
      action: upgradeFenceActivityAction(transition),
      entityType: "instance_settings",
      entityId: UPGRADE_ADMISSION_FENCE_KEY,
      details: {
        from: transition.from,
        to: transition.to,
        epoch: transition.epoch,
        reason: transition.reason,
        at: transition.at,
        ...(transition.note ? { note: transition.note } : {}),
      },
    });
    publications.push(publication);
  }
}

/** Post-commit only: the audit rows already committed, so a publish failure is logged, not raised. */
function publishFenceActivities(publications: ActivityPublication[]) {
  for (const publication of publications) {
    try {
      publishActivity(publication);
    } catch (err) {
      logger.error({ err, companyId: publication.companyId }, "failed to publish upgrade fence activity event");
    }
  }
}

async function databaseNow(db: Db): Promise<number> {
  const [row] = await execRows(db, sql`select (extract(epoch from clock_timestamp()) * 1000)::float8 as now_ms`);
  const nowMs = Number(row?.now_ms);
  if (!Number.isFinite(nowMs)) throw new Error("upgrade_fence_database_time_unavailable");
  return nowMs;
}

function isLockTimeout(error: unknown) {
  const code = (error as { code?: unknown; cause?: { code?: unknown } } | null);
  return code?.code === "55P03" || code?.cause?.code === "55P03";
}

async function writeFenceState(tx: Db, state: UpgradeFenceState) {
  await tx
    .update(instanceSettings)
    .set({ general: state as unknown as Record<string, unknown>, updatedAt: new Date() })
    .where(eq(instanceSettings.singletonKey, UPGRADE_ADMISSION_FENCE_KEY));
}

/**
 * Every fence mutation: exclusive advisory lock as the first statement (with a
 * bounded wait), then the row in a later statement. An absent or unreadable
 * row is never recreated here (admission-design r3 §3.2).
 */
async function withFenceMutation<T>(
  db: Db,
  run: (tx: Db, current: UpgradeFenceState, nowMs: number, publications: ActivityPublication[]) => Promise<T>,
): Promise<T> {
  let publications: ActivityPublication[] = [];
  let result: T;
  try {
    result = await db.transaction(async (rawTx) => {
      publications = [];
      const tx = rawTx as unknown as Db;
      await tx.execute(sql.raw(`set local lock_timeout = '${MUTATION_LOCK_TIMEOUT}'`));
      await tx.execute(
        sql`select pg_advisory_xact_lock(${UPGRADE_FENCE_LOCK.classId}::int4, ${UPGRADE_FENCE_LOCK.objectId}::int4)`,
      );
      const fence = await readFenceRow(tx);
      if (fence.kind === "absent")
        throw new UpgradeFenceMutationError("fence_row_missing", "The upgrade admission fence row is missing; the instance is stopped for its owner.", "stopped_for_owner");
      if (fence.kind === "unreadable")
        throw new UpgradeFenceMutationError("fence_row_unreadable", `The upgrade admission fence row is unreadable (${fence.detail}).`, "stopped_for_owner");
      return run(tx, fence.state, await databaseNow(tx), publications);
    });
  } catch (error) {
    if (isLockTimeout(error))
      throw new UpgradeFenceMutationError("upgrade_fence_busy", "Another upgrade fence operation holds the fence lock.");
    throw error;
  }
  publishFenceActivities(publications);
  return result;
}

export function upgradeAdmissionFenceService(db: Db) {
  async function status(): Promise<UpgradeFenceStatus> {
    // Read-only: reports a pending expiry but never writes it.
    const fence = await readFenceRow(db);
    const nowMs = await databaseNow(db);
    const base = { key: UPGRADE_ADMISSION_FENCE_KEY, databaseTime: new Date(nowMs).toISOString() } as const;
    if (fence.kind !== "valid") {
      return {
        ...base,
        present: fence.kind === "unreadable",
        readable: false,
        phase: "stopped_for_owner",
        reason: fence.kind === "absent" ? "fence_row_missing" : "fence_row_unreadable",
        epoch: null,
        heldUntil: null,
        leaseUntil: null,
        expiryPending: false,
        owner: null,
        candidate: null,
        initializedBy: null,
        admitsRunClaims: fence.kind === "absent" && fenceMode === "test_absent_open",
      };
    }
    const state = fence.state;
    return {
      ...base,
      present: true,
      readable: true,
      phase: state.phase,
      reason: state.reason,
      epoch: state.epoch,
      heldUntil: state.heldUntil,
      leaseUntil: state.leaseUntil,
      expiryPending: expireUpgradeFenceState(state, nowMs).transition !== null,
      owner: state.owner ? { actor: state.owner.actor, heldAt: state.owner.heldAt } : null,
      candidate: state.candidate,
      initializedBy: state.initializedBy,
      admitsRunClaims: state.phase === "open",
    };
  }

  /** Commits a due expiry, if any. Safe to call from a periodic sweep. */
  async function sweepExpired(): Promise<UpgradeFenceTransition | null> {
    const fence = await readFenceRow(db);
    if (fence.kind !== "valid" || fence.state.phase === "open" || fence.state.phase === "stopped_for_owner") return null;
    return withFenceMutation(db, async (tx, current, nowMs, publications) => {
      const expired = expireUpgradeFenceState(current, nowMs);
      if (!expired.transition) return null;
      await writeFenceState(tx, expired.state);
      await auditFenceTransition(tx, expired.transition, UPGRADE_FENCE_EXPIRY_ACTOR, publications);
      return expired.transition;
    });
  }

  /** open → held. Returns the owner token once; only its hash is stored. */
  async function hold(input: {
    actor: UpgradeFenceActor;
    activityActor: UpgradeFenceActivityActor;
    ttlSeconds?: number;
    candidate?: Record<string, unknown> | null;
  }) {
    const ttlSeconds = input.ttlSeconds ?? UPGRADE_FENCE_DEFAULT_TTL_SECONDS;
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < UPGRADE_FENCE_MIN_TTL_SECONDS || ttlSeconds > UPGRADE_FENCE_MAX_TTL_SECONDS)
      throw new UpgradeFenceMutationError("upgrade_fence_invalid_ttl", `ttlSeconds must be an integer from ${UPGRADE_FENCE_MIN_TTL_SECONDS} to ${UPGRADE_FENCE_MAX_TTL_SECONDS}.`);
    const token = randomBytes(32).toString("base64url");
    return withFenceMutation(db, async (tx, current, nowMs, publications) => {
      const expired = expireUpgradeFenceState(current, nowMs);
      let state = expired.state;
      // A refused hold below rolls this expiry back too; the next sweep commits it.
      if (expired.transition) await auditFenceTransition(tx, expired.transition, UPGRADE_FENCE_EXPIRY_ACTOR, publications);
      if (state.phase === "held")
        throw new UpgradeFenceMutationError("upgrade_fence_held", "The upgrade admission fence is already held.", state.phase);
      if (state.phase !== "open")
        throw new UpgradeFenceMutationError("upgrade_fence_not_holdable", `The upgrade admission fence is ${state.phase}.`, state.phase);
      const at = new Date(nowMs).toISOString();
      const epoch = state.epoch + 1;
      const transition: UpgradeFenceTransition = { from: "open", to: "held", epoch, reason: "held_by_owner", actor: input.actor, at };
      state = withTransition({
        ...state,
        epoch,
        phase: "held",
        reason: "held_by_owner",
        owner: { tokenSha256: hashUpgradeFenceToken(token), actor: input.actor, heldAt: at },
        heldUntil: new Date(nowMs + ttlSeconds * 1000).toISOString(),
        candidate: input.candidate ?? null,
      }, transition);
      await writeFenceState(tx, state);
      await auditFenceTransition(tx, transition, input.activityActor, publications);
      return { phase: "held" as const, epoch, ownerToken: token, heldUntil: state.heldUntil!, transition };
    });
  }

  /** held → open by its owner: the pre-activation abort. Any other phase refuses. */
  async function abort(input: {
    actor: UpgradeFenceActor;
    activityActor: UpgradeFenceActivityActor;
    epoch: number;
    ownerToken: string;
    reason?: string | null;
  }) {
    return withFenceMutation(db, async (tx, current, nowMs, publications) => {
      if (current.phase !== "held")
        throw new UpgradeFenceMutationError("upgrade_fence_not_abortable", `The upgrade admission fence is ${current.phase}; only a held fence can be aborted.`, current.phase);
      if (current.epoch !== input.epoch || !current.owner || !tokenMatches(input.ownerToken, current.owner.tokenSha256))
        throw new UpgradeFenceMutationError("upgrade_fence_stale_owner", "The epoch or owner token does not match the held fence.", current.phase);
      const expired = expireUpgradeFenceState(current, nowMs);
      if (expired.transition) {
        await writeFenceState(tx, expired.state);
        await auditFenceTransition(tx, expired.transition, UPGRADE_FENCE_EXPIRY_ACTOR, publications);
        return { phase: "open" as const, epoch: current.epoch, transition: expired.transition };
      }
      const note = input.reason?.trim() ? input.reason.trim().slice(0, 500) : null;
      const transition: UpgradeFenceTransition = {
        from: "held", to: "open", epoch: current.epoch, reason: "aborted_by_owner",
        actor: input.actor, at: new Date(nowMs).toISOString(), ...(note ? { note } : {}),
      };
      const state = withTransition({
        ...current,
        phase: "open",
        reason: "aborted_by_owner",
        owner: null,
        heldUntil: null,
        candidate: null,
      }, transition);
      await writeFenceState(tx, state);
      await auditFenceTransition(tx, transition, input.activityActor, publications);
      return { phase: "open" as const, epoch: current.epoch, transition };
    });
  }

  return { status, sweepExpired, hold, abort };
}

/**
 * The only phase-1 initializer (admission-design r3 §3.2): a fresh install, in
 * the same invocation that created this database's migration journal. Any
 * other caller refuses. A present row is never overwritten.
 */
export async function initializeUpgradeAdmissionFence(
  db: Db,
  input: { mode: "fresh_install"; createdMigrationJournal: boolean; identity?: Record<string, unknown> | null },
): Promise<{ created: boolean }> {
  if (input.mode !== "fresh_install" || input.createdMigrationJournal !== true)
    throw new UpgradeFenceMutationError("fence_init_requires_bootstrap", "Only the invocation that created this database's migration journal may initialize the upgrade admission fence.");
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    await tx.execute(sql.raw(`set local lock_timeout = '${MUTATION_LOCK_TIMEOUT}'`));
    await tx.execute(
      sql`select pg_advisory_xact_lock(${UPGRADE_FENCE_LOCK.classId}::int4, ${UPGRADE_FENCE_LOCK.objectId}::int4)`,
    );
    const nowMs = await databaseNow(tx);
    const at = new Date(nowMs).toISOString();
    const initializationId = randomUUID();
    const state: UpgradeFenceState = {
      version: 1,
      epoch: 0,
      phase: "open",
      initializedBy: "fresh_install",
      initializationId,
      initializedAt: at,
      identity: input.identity ?? null,
      owner: null,
      heldUntil: null,
      leaseUntil: null,
      reason: null,
      candidate: null,
      history: [],
    };
    const inserted = await tx
      .insert(instanceSettings)
      .values({ singletonKey: UPGRADE_ADMISSION_FENCE_KEY, general: state as unknown as Record<string, unknown> })
      .onConflictDoNothing({ target: instanceSettings.singletonKey })
      .returning({ id: instanceSettings.id });
    if (inserted.length === 0) return { created: false };
    // r6 §3.10.8: a fresh install records a committed episode with its fence row.
    await tx
      .insert(instanceSettings)
      .values({
        singletonKey: UPGRADE_BOOTSTRAP_EPISODE_KEY,
        general: {
          current: { bootstrapId: null, kind: "fresh_install", state: "committed", initializationId, decidedAt: at },
          prior: [],
        },
      })
      .onConflictDoNothing({ target: instanceSettings.singletonKey });
    return { created: true };
  });
}

/**
 * Server boot, before startup recovery, claim loops or workers: initialize only
 * for a fresh install, then report the effective phase. Never writes for an
 * existing database; an absent row leaves the instance stopped for its owner.
 */
export async function bootUpgradeAdmissionFence(
  db: Db,
  input: { createdMigrationJournal: boolean; identity?: Record<string, unknown> | null },
): Promise<UpgradeFenceStatus> {
  if (input.createdMigrationJournal) {
    await initializeUpgradeAdmissionFence(db, {
      mode: "fresh_install",
      createdMigrationJournal: true,
      identity: input.identity ?? null,
    });
  }
  return upgradeAdmissionFenceService(db).status();
}
