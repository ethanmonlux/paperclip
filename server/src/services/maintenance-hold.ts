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
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { heartbeatRuns, maintenanceHolds, type Db } from "@paperclipai/db";
import {
  applyMaintenanceHold,
  setMaintenanceDrainDeadlineHandler,
  subscribeMaintenanceHoldExpiry,
  type MaintenanceHoldState,
} from "./task-admission.js";
import { logger } from "../middleware/logger.js";
import type { WakeupOptions } from "./heartbeat/run-preparation.js";

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
};

export type MaintenanceHoldHeartbeat = {
  drainRunningRunsForShutdown: (
    signal: "SIGINT" | "SIGTERM",
    now?: Date,
    runIds?: readonly string[] | null,
    options?: { cause?: "shutdown" | "maintenance_hold" },
  ) => Promise<{
    interrupted: number;
    interruptedRuns: Array<{ runId: string; agentId: string; companyId: string; issueId: string | null }>;
  }>;
  wakeup: (agentId: string, opts: WakeupOptions) => Promise<unknown>;
  resumeQueuedRunsAfterDrain: (scope?: { companyId: string }, options?: { staggerMs?: number }) => Promise<void>;
};

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

  async function status(now = new Date()): Promise<MaintenanceHoldStatus> {
    const row = await readActive(now);
    const [counts] = await db.select({
      queuedRuns: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'queued')::int`,
      runningRuns: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'running')::int`,
    }).from(heartbeatRuns).where(sql`${heartbeatRuns.status} in ('queued', 'running')`);
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
      runningRuns: Number(counts?.runningRuns ?? 0),
    };
  }

  /**
   * Park the runs still running at the drain deadline. Each is stopped
   * gracefully with its session kept, and its task gets a continuation wake
   * that stays queued behind the hold. Nothing is cancelled.
   */
  async function parkRunningRuns(heartbeat: MaintenanceHoldHeartbeat, hold: MaintenanceHoldState, now = new Date()) {
    const running = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "running"));
    const result = running.length > 0
      ? await heartbeat.drainRunningRunsForShutdown("SIGTERM", now, running.map(row => row.id), { cause: "maintenance_hold" })
      : { interrupted: 0, interruptedRuns: [] };
    for (const parked of result.interruptedRuns) {
      if (!parked.issueId) continue;
      try {
        await heartbeat.wakeup(parked.agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: MAINTENANCE_WINDOW_RESUME_WAKE_REASON,
          payload: { issueId: parked.issueId, waitFor: "maintenance_window", maintenanceHoldId: hold.id,
            parkedRunId: parked.runId, instruction: PARKED_RESUME_INSTRUCTION },
          idempotencyKey: `maintenance_window_resume:${hold.id}:${parked.runId}`,
          requestedByActorType: "system",
          requestedByActorId: "maintenance_hold",
          contextSnapshot: {
            issueId: parked.issueId, taskId: parked.issueId, wakeReason: MAINTENANCE_WINDOW_RESUME_WAKE_REASON,
            source: "instance.maintenance_hold.parked", waitFor: "maintenance_window",
            parkedRunId: parked.runId, instruction: PARKED_RESUME_INSTRUCTION,
          },
        });
      } catch (err) {
        logger.error({ err, runId: parked.runId, issueId: parked.issueId },
          "maintenance hold parked a run but could not queue its continuation; the stalled-task recovery owns it");
      }
    }
    await markParked(hold.id, result.interrupted, now);
    logger.info({ holdId: hold.id, parked: result.interrupted }, "maintenance hold drain deadline reached");
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
