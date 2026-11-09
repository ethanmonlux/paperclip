/**
 * Nightly maintenance window (FAC-840 C1, STA-182).
 *
 * The managed upgrade cannot wait for a natural zero-run moment on a busy
 * instance, so it makes its own quiet:
 *
 * 1. Hold: the managed script (or a board instance admin) places a hold. The
 *    server stops starting runs; every wake, assignment and comment is still
 *    recorded and stays queued. Running runs are not cancelled.
 * 2. Drain deadline: runs still running then are parked: stopped gracefully,
 *    their session kept, and a continuation wake queued behind the hold.
 * 3. The script upgrades with zero running runs, then releases the hold. Held
 *    work starts in priority order, staggered across agents.
 *
 * The hold is a database record loaded at startup, so the install restart
 * keeps it. It always lifts at `expiresAt`, even if the script dies.
 */
import { and, eq, isNull, lte, sql, type SQL } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, maintenanceHolds, type Db } from "@paperclipai/db";
import {
  applyMaintenanceHold,
  setMaintenanceDrainDeadlineHandler,
  subscribeMaintenanceHoldExpiry,
  type MaintenanceHoldState,
} from "./task-admission.js";
import { logger } from "../middleware/logger.js";
import type { WakeupOptions } from "./heartbeat/run-preparation.js";
import type { ParkedRun } from "./heartbeat/recovery.js";

export const MAINTENANCE_HOLD_DEFAULT_DRAIN_MS = 45 * 60_000;
export const MAINTENANCE_HOLD_DEFAULT_MAX_MS = 90 * 60_000;
/** No hold, however often it is renewed, outlives this from its start. */
export const MAINTENANCE_HOLD_MAX_TOTAL_MS = 4 * 60 * 60_000;
export const MAINTENANCE_RELEASE_STAGGER_MS = 5_000;
export const MAINTENANCE_WINDOW_RESUME_WAKE_REASON = "maintenance_window_resume" as const;
const PARKED_RESUME_INSTRUCTION =
  "Your previous run was parked at the maintenance window's drain deadline before it finished. " +
  "Continue the task from where it stopped.";

type MaintenanceHoldRow = typeof maintenanceHolds.$inferSelect;

export type MaintenanceHoldStatus = {
  active: boolean;
  hold: {
    id: string;
    startedAt: string;
    drainDeadlineAt: string;
    expiresAt: string;
    parkedAt: string | null;
    parkedRunCount: number;
    reason: string;
  } | null;
  queuedRuns: number;
  runningRuns: number;
  /** In-process executions and stop settlements still active (this process only). */
  settlingRuns: number;
  /** Runs this hold parked whose continuation wake is not yet recorded. */
  pendingContinuations: number;
  /** Work an install would cut short: the sum of the three counts above. */
  blockingWork: number;
  /** True only when nothing is running, settling or awaiting its continuation. */
  quiet: boolean;
};

/** Parking is incomplete; the admission slot retries it after a minute. */
export class MaintenanceParkingPendingError extends Error {
  constructor(readonly progress: { runningRuns: number; settlingRuns: number }) {
    super(`maintenance hold parking is still pending (running=${progress.runningRuns}, settling=${progress.settlingRuns})`);
    this.name = "MaintenanceParkingPendingError";
  }
}

export type MaintenanceHoldHeartbeat = {
  drainRunningRunsForShutdown: (
    signal: "SIGINT" | "SIGTERM",
    now?: Date,
    runIds?: readonly string[] | null,
    options?: { cause?: "shutdown" | "maintenance_hold"; onParked?: (parked: ParkedRun) => Promise<void> },
  ) => Promise<{ interrupted: number; interruptedRuns: ParkedRun[] }>;
  wakeup: (agentId: string, opts: WakeupOptions) => Promise<unknown>;
  resumeQueuedRunsAfterDrain: (scope?: { companyId: string }, options?: { staggerMs?: number }) => Promise<void>;
  /** In-process work; `activeRuns` includes stop settlements past the response wait. */
  getTaskDrainStatus: () => { activeRuns: number };
};

type InProcessWork = () => { activeRuns: number };

const continuationKey = (holdId: string, runId: string) => `${MAINTENANCE_WINDOW_RESUME_WAKE_REASON}:${holdId}:${runId}`;
// The wake keeps its key when it queues. For an adapter without a safe resume
// checkpoint it is saved as an execution wait under that wait's own key, but
// its payload still names the hold and the parked run.
function continuationRecorded(holdId: string, runId: SQL | string) {
  return sql`(${agentWakeupRequests.idempotencyKey} = ${MAINTENANCE_WINDOW_RESUME_WAKE_REASON}::text || ':' || ${holdId}::text || ':' || (${runId})::text
    or (${agentWakeupRequests.payload}->>'maintenanceHoldId' = ${holdId}::text
      and ${agentWakeupRequests.payload}->>'parkedRunId' = (${runId})::text))`;
}
// A run this hold stamped that stopped with work left to continue. A run a
// person stopped during the window stays stopped.
function parkedByHold(holdId: string) {
  return sql`(${heartbeatRuns.resultJson}->'maintenanceHoldPark'->>'holdId' = ${holdId}::text
    and (${heartbeatRuns.status} in ('interrupted', 'failed', 'timed_out')
      or (${heartbeatRuns.status} = 'cancelled'
        and coalesce(${heartbeatRuns.resultJson}->>'cancelledByActorType', '') = ''
        and coalesce(${heartbeatRuns.resultJson}->>'cancelledByUserId', '') = '')))`;
}

function toState(row: MaintenanceHoldRow): MaintenanceHoldState {
  return {
    id: row.id,
    startedAt: row.startedAt,
    drainDeadlineAt: row.drainDeadlineAt,
    expiresAt: row.expiresAt,
    parkedAt: row.parkedAt,
  };
}

function boundedDuration(value: number | null | undefined, fallback: number, min: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), MAINTENANCE_HOLD_MAX_TOTAL_MS);
}

export function maintenanceHoldService(db: Db) {
  async function settleExpired(now: Date) {
    const expired = await db.update(maintenanceHolds)
      .set({ releasedAt: now, releaseReason: "expired", updatedAt: now })
      .where(and(isNull(maintenanceHolds.releasedAt), lte(maintenanceHolds.expiresAt, now)))
      .returning({ id: maintenanceHolds.id });
    for (const row of expired) logger.warn({ holdId: row.id }, "maintenance hold reached its maximum duration and released itself");
    return expired.length;
  }

  async function readActive(now = new Date()) {
    await settleExpired(now);
    const [row] = await db.select().from(maintenanceHolds).where(isNull(maintenanceHolds.releasedAt)).limit(1);
    return row ?? null;
  }

  /** Restore an active hold into admission. Call before any queued run can start. */
  async function load(now = new Date()) {
    const row = await readActive(now);
    applyMaintenanceHold(row ? toState(row) : null);
    return row;
  }

  /**
   * Place the hold, or renew an active one. Renewal only moves `expiresAt`
   * later, and never past MAINTENANCE_HOLD_MAX_TOTAL_MS from the hold's start.
   */
  async function place(input: {
    drainMs?: number | null;
    maxMs?: number | null;
    reason?: string | null;
    actorType: string;
    actorId: string;
  }, now = new Date()) {
    // A zero drain parks running runs at once; the hold itself lasts at least a minute.
    const drainMs = boundedDuration(input.drainMs, MAINTENANCE_HOLD_DEFAULT_DRAIN_MS, 0);
    const maxMs = boundedDuration(input.maxMs, MAINTENANCE_HOLD_DEFAULT_MAX_MS, 60_000);
    await settleExpired(now);
    const result = await db.transaction(async tx => {
      const [active] = await tx.select().from(maintenanceHolds)
        .where(isNull(maintenanceHolds.releasedAt)).limit(1).for("update");
      if (active) {
        const ceiling = active.startedAt.getTime() + MAINTENANCE_HOLD_MAX_TOTAL_MS;
        const expiresAt = new Date(Math.min(Math.max(active.expiresAt.getTime(), now.getTime() + maxMs), ceiling));
        const [renewed] = await tx.update(maintenanceHolds)
          .set({ expiresAt, updatedAt: now })
          .where(eq(maintenanceHolds.id, active.id))
          .returning();
        return { row: renewed!, created: false };
      }
      const expiresAt = new Date(now.getTime() + maxMs);
      const [created] = await tx.insert(maintenanceHolds).values({
        startedAt: now,
        drainDeadlineAt: new Date(Math.min(now.getTime() + drainMs, expiresAt.getTime())),
        expiresAt,
        reason: (input.reason ?? "").trim().slice(0, 200) || "maintenance window",
        startedByActorType: input.actorType,
        startedByActorId: input.actorId,
        updatedAt: now,
      }).returning();
      return { row: created!, created: true };
    });
    applyMaintenanceHold(toState(result.row));
    return result;
  }

  /** Lift the hold. Held work is started by the caller through `releaseHeldWork`. */
  async function release(reason: string, now = new Date()) {
    await settleExpired(now);
    const released = await db.update(maintenanceHolds)
      .set({ releasedAt: now, releaseReason: reason.trim().slice(0, 200) || "released", updatedAt: now })
      .where(isNull(maintenanceHolds.releasedAt))
      .returning();
    applyMaintenanceHold(null);
    return { wasActive: released.length > 0, hold: released[0] ?? null };
  }

  async function markParked(holdId: string, parkedRunCount: number, now = new Date()) {
    await db.update(maintenanceHolds)
      .set({ parkedAt: now, parkedRunCount, updatedAt: now })
      .where(and(eq(maintenanceHolds.id, holdId), isNull(maintenanceHolds.releasedAt)));
  }

  /**
   * Runs this hold stamped for parking that stopped without a recorded
   * continuation. The stamp is on the run row, so this survives a restart.
   */
  async function parkedWithoutContinuation(holdId: string) {
    return db.select({
      runId: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      companyId: heartbeatRuns.companyId,
      issueId: sql<string | null>`coalesce(${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId')`,
    }).from(heartbeatRuns).where(and(
      parkedByHold(holdId),
      sql`coalesce(${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') is not null`,
      sql`not exists (select 1 from ${agentWakeupRequests}
        where ${agentWakeupRequests.companyId} = ${heartbeatRuns.companyId}
          and ${continuationRecorded(holdId, sql`${heartbeatRuns.id}::text`)})`,
    ));
  }

  async function status(now = new Date(), inProcess?: InProcessWork): Promise<MaintenanceHoldStatus> {
    const row = await readActive(now);
    const [counts] = await db.select({
      queuedRuns: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'queued')::int`,
      runningRuns: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'running')::int`,
    }).from(heartbeatRuns).where(sql`${heartbeatRuns.status} in ('queued', 'running')`);
    const runningRuns = Number(counts?.runningRuns ?? 0);
    const settlingRuns = inProcess?.().activeRuns ?? 0;
    const pendingContinuations = row ? (await parkedWithoutContinuation(row.id)).length : 0;
    const blockingWork = runningRuns + settlingRuns + pendingContinuations;
    return {
      active: row !== null,
      hold: row ? {
        id: row.id,
        startedAt: row.startedAt.toISOString(),
        drainDeadlineAt: row.drainDeadlineAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        parkedAt: row.parkedAt?.toISOString() ?? null,
        parkedRunCount: row.parkedRunCount,
        reason: row.reason,
      } : null,
      queuedRuns: Number(counts?.queuedRuns ?? 0),
      runningRuns,
      settlingRuns,
      pendingContinuations,
      blockingWork,
      quiet: blockingWork === 0,
    };
  }

  async function queueContinuation(heartbeat: MaintenanceHoldHeartbeat, hold: Pick<MaintenanceHoldState, "id">, parked: ParkedRun) {
    if (!parked.issueId) return;
    const key = continuationKey(hold.id, parked.runId);
    const [existing] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, parked.companyId), continuationRecorded(hold.id, parked.runId))).limit(1);
    if (existing) return;
    await heartbeat.wakeup(parked.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: MAINTENANCE_WINDOW_RESUME_WAKE_REASON,
      payload: { issueId: parked.issueId, waitFor: "maintenance_window", maintenanceHoldId: hold.id,
        parkedRunId: parked.runId, instruction: PARKED_RESUME_INSTRUCTION },
      idempotencyKey: key,
      requestedByActorType: "system",
      requestedByActorId: "maintenance_hold",
      contextSnapshot: {
        issueId: parked.issueId, taskId: parked.issueId, wakeReason: MAINTENANCE_WINDOW_RESUME_WAKE_REASON,
        source: "instance.maintenance_hold.parked", waitFor: "maintenance_window",
        parkedRunId: parked.runId, instruction: PARKED_RESUME_INSTRUCTION,
      },
    });
  }

  /**
   * Park the runs still running at the drain deadline. Each is stamped with
   * the hold, stopped gracefully with its session kept, and its task gets a
   * continuation wake that stays queued behind the hold. Nothing is cancelled.
   *
   * Parking completes only at real quiet: no running row, no in-process
   * execution or stop settlement, and a continuation recorded for every
   * stamped run. Until then it throws MaintenanceParkingPendingError and the
   * admission slot retries a minute later. A run this pass could not stop (an
   * accepted native result still finalizing, a session still opening) is
   * retried; a stop that settles after the response wait queues its own
   * continuation; and a restart mid-settlement is covered because the stamp
   * is durable and every pass, including the first after startup, queues any
   * missing continuation.
   */
  async function parkRunningRuns(heartbeat: MaintenanceHoldHeartbeat, hold: MaintenanceHoldState, now = new Date()) {
    const stamped = await db.update(heartbeatRuns)
      .set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || jsonb_build_object('maintenanceHoldPark',
        coalesce(${heartbeatRuns.resultJson}->'maintenanceHoldPark',
          jsonb_build_object('holdId', ${hold.id}::text, 'requestedAt', ${now.toISOString()}::text)))` })
      .where(eq(heartbeatRuns.status, "running"))
      .returning({ id: heartbeatRuns.id });
    const result = stamped.length > 0
      ? await heartbeat.drainRunningRunsForShutdown("SIGTERM", now, stamped.map(row => row.id), {
        cause: "maintenance_hold",
        onParked: parked => queueContinuation(heartbeat, hold, parked),
      })
      : { interrupted: 0, interruptedRuns: [] };
    const [counts] = await db.select({ running: sql<number>`count(*)::int` }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "running"));
    const progress = { runningRuns: Number(counts?.running ?? 0), settlingRuns: heartbeat.getTaskDrainStatus().activeRuns };
    if (progress.runningRuns > 0 || progress.settlingRuns > 0) {
      logger.info({ holdId: hold.id, parkedThisPass: result.interrupted, ...progress },
        "maintenance hold drain deadline: parking still pending, retrying");
      throw new MaintenanceParkingPendingError(progress);
    }
    // Settled: record any continuation a slow or interrupted settlement did not.
    const missing = await parkedWithoutContinuation(hold.id);
    for (const parked of missing) await queueContinuation(heartbeat, hold, parked);
    const [parkedCount] = await db.select({ n: sql<number>`count(*)::int` }).from(heartbeatRuns)
      .where(parkedByHold(hold.id));
    await markParked(hold.id, Number(parkedCount?.n ?? 0), now);
    logger.info({ holdId: hold.id, parked: Number(parkedCount?.n ?? 0), lateContinuations: missing.length },
      "maintenance hold drain deadline reached; parking complete");
    return result;
  }

  async function releaseHeldWork(heartbeat: MaintenanceHoldHeartbeat, staggerMs = MAINTENANCE_RELEASE_STAGGER_MS) {
    await heartbeat.resumeQueuedRunsAfterDrain(undefined, { staggerMs });
  }

  /**
   * Wire the drain deadline and the auto-release into this process. On expiry
   * the record is settled and held work starts, exactly as on a release.
   */
  function attach(heartbeat: MaintenanceHoldHeartbeat, opts: { canRun?: () => boolean } = {}) {
    const detachDeadline = setMaintenanceDrainDeadlineHandler(async hold => {
      if (opts.canRun && !opts.canRun()) throw new Error("heartbeat scheduler is not running");
      await parkRunningRuns(heartbeat, hold);
    });
    const unsubscribe = subscribeMaintenanceHoldExpiry(hold => {
      void settleExpired(new Date()).catch(err => logger.error({ err, holdId: hold.id },
        "maintenance hold expired in this process but its record could not be settled; the next read settles it"));
      if (opts.canRun && !opts.canRun()) return;
      void releaseHeldWork(heartbeat).catch(err => logger.error({ err },
        "failed to start held work after the maintenance hold expired; it remains queued"));
    });
    return () => { detachDeadline(); unsubscribe(); };
  }

  return { load, place, release, status, parkRunningRuns, releaseHeldWork, attach, readActive, settleExpired };
}
