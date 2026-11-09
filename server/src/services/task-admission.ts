import { randomUUID } from "node:crypto";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";

export type TaskDrainState = { startedAt: Date; expiresAt: Date | null; ownerId?: string };
let taskDrainState: TaskDrainState | null = null;
const expiryListeners = new Set<() => void>();
const changeListeners = new Set<() => void>();

function notifyDrainChanged() {
  for (const listener of changeListeners) listener();
}
export function subscribeTaskDrainChanges(listener: () => void) {
  changeListeners.add(listener);
  return () => { changeListeners.delete(listener); };
}
export function subscribeTaskDrainExpiry(listener: () => void) {
  expiryListeners.add(listener);
  return () => { expiryListeners.delete(listener); };
}

// The shared coordinator owns this process-local deadline and its shutdown.
// Reading admission can also establish expiry, so both paths notify the same
// listener. No database scan or recurring timer is needed while idle.
export function registerTaskDrainExpiryWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  onExpired: () => void,
) {
  const worker = coordinator.register(DELIVERY_QUEUES.taskDrainExpiry, {
    retryMs: 1000,
    runDuringDrain: true,
    run: async () => {
      const now = new Date();
      readTaskDrain(now);
      await runMaintenanceDrainDeadline(now);
    },
    hasPending: async () => false,
    nextRunAt: () => earliestExpiry(),
  });
  expiryListeners.add(onExpired);
  changeListeners.add(worker.wake);
  return {
    ready: worker.ready,
    async stop() {
      changeListeners.delete(worker.wake);
      expiryListeners.delete(onExpired);
      await worker.stop();
    },
  };
}

// Set while this server cannot renew its controller instance lease: it stops
// dispatching new work until the lease is renewed (or it exits). It never
// replaces an operator's drain and has no idle owner, so HTTP stays open.
let controllerLeaseQuiesce: TaskDrainState | null = null;
export function setControllerLeaseQuiesce(quiesced: boolean): void {
  if (quiesced === (controllerLeaseQuiesce !== null)) return;
  controllerLeaseQuiesce = quiesced ? { startedAt: new Date(), expiresAt: null } : null;
  notifyDrainChanged();
}

/**
 * The managed nightly maintenance window (FAC-840 C1). It holds admission like
 * an operator drain, but it is loaded from the database at startup, so the
 * install restart keeps it until the managed script releases it. Its expiry is
 * the auto-release that lifts the hold even if that script dies.
 */
export type MaintenanceHoldState = {
  id: string;
  startedAt: Date;
  drainDeadlineAt: Date;
  expiresAt: Date;
  parkedAt: Date | null;
};
let maintenanceHold: MaintenanceHoldState | null = null;
const maintenanceExpiryListeners = new Set<(hold: MaintenanceHoldState) => void>();

export function subscribeMaintenanceHoldExpiry(listener: (hold: MaintenanceHoldState) => void) {
  maintenanceExpiryListeners.add(listener);
  return () => { maintenanceExpiryListeners.delete(listener); };
}

export function applyMaintenanceHold(hold: MaintenanceHoldState | null): void {
  maintenanceHold = hold;
  notifyDrainChanged();
}

// An expired hold resumes held work through its own (staggered) release; the
// generic listeners resume an expired operator drain.
function notifyExpired(drainExpired: boolean, maintenance: MaintenanceHoldState | null) {
  if (maintenance) {
    for (const listener of maintenanceExpiryListeners) {
      try { listener(maintenance); } catch (error) { process.emitWarning(`Maintenance hold expiry notification failed: ${String(error)}`); }
    }
  }
  if (!drainExpired) return;
  for (const listener of expiryListeners) {
    try { listener(); } catch (error) { process.emitWarning(`Task drain expiry notification failed: ${String(error)}`); }
  }
}

export function readMaintenanceHold(now: Date): MaintenanceHoldState | null {
  readTaskDrain(now);
  return maintenanceHold;
}

// Parks the runs still running at the drain deadline. Registered by the
// maintenance hold service; it runs once per hold, and a failed attempt retries
// after a minute rather than spinning the expiry worker.
let drainDeadlineHandler: ((hold: MaintenanceHoldState) => Promise<void>) | null = null;
let drainDeadlineRetryAt: number | null = null;
const DRAIN_DEADLINE_RETRY_MS = 60_000;

export function setMaintenanceDrainDeadlineHandler(handler: ((hold: MaintenanceHoldState) => Promise<void>) | null) {
  drainDeadlineHandler = handler;
  drainDeadlineRetryAt = null;
  notifyDrainChanged();
  return () => {
    if (drainDeadlineHandler === handler) drainDeadlineHandler = null;
  };
}

function pendingDrainDeadline(): number | null {
  if (!maintenanceHold || maintenanceHold.parkedAt || !drainDeadlineHandler) return null;
  return Math.max(maintenanceHold.drainDeadlineAt.getTime(), drainDeadlineRetryAt ?? 0);
}

export async function runMaintenanceDrainDeadline(now: Date): Promise<boolean> {
  const hold = maintenanceHold;
  const due = pendingDrainDeadline();
  if (!hold || !drainDeadlineHandler || due === null || due > now.getTime()) return false;
  try {
    await drainDeadlineHandler(hold);
    drainDeadlineRetryAt = null;
    if (maintenanceHold?.id === hold.id && !maintenanceHold.parkedAt) {
      maintenanceHold = { ...maintenanceHold, parkedAt: new Date() };
    }
    notifyDrainChanged();
    return true;
  } catch (error) {
    drainDeadlineRetryAt = Date.now() + DRAIN_DEADLINE_RETRY_MS;
    // Parking that is still waiting for runs to stop is progress, not a fault.
    if (!(error instanceof Error && error.name === "MaintenanceParkingPendingError")) {
      process.emitWarning(`Maintenance hold could not park running runs; retrying: ${String(error)}`);
    }
    notifyDrainChanged();
    return false;
  }
}

function earliestExpiry(): number | null {
  const times = [taskDrainState?.expiresAt?.getTime(), maintenanceHold?.expiresAt.getTime(), pendingDrainDeadline()]
    .filter((time): time is number => typeof time === "number");
  return times.length > 0 ? Math.min(...times) : null;
}

export function readTaskDrain(now: Date): TaskDrainState | null {
  let drainExpired = false;
  if (taskDrainState?.expiresAt && taskDrainState.expiresAt.getTime() <= now.getTime()) {
    taskDrainState = null;
    drainExpired = true;
  }
  let expiredHold: MaintenanceHoldState | null = null;
  if (maintenanceHold && maintenanceHold.expiresAt.getTime() <= now.getTime()) {
    expiredHold = maintenanceHold;
    maintenanceHold = null;
  }
  if (drainExpired || expiredHold) notifyExpired(drainExpired, expiredHold);
  return taskDrainState
    ?? (maintenanceHold ? { startedAt: maintenanceHold.startedAt, expiresAt: maintenanceHold.expiresAt } : null)
    ?? controllerLeaseQuiesce;
}

export function computeTaskDrain(opts: { ttlMs?: number | null; purpose?: "idle" } = {}): TaskDrainState {
  const startedAt = new Date();
  return { startedAt, expiresAt: opts.ttlMs == null ? null : new Date(startedAt.getTime() + opts.ttlMs),
    ...(opts.purpose === "idle" ? { ownerId: randomUUID() } : {}) };
}

export function applyTaskDrain(drain: TaskDrainState): void {
  taskDrainState = drain;
  notifyDrainChanged();
}
export function startTaskDrain(opts: { ttlMs?: number | null; purpose?: "idle" } = {}): TaskDrainState {
  const drain = computeTaskDrain(opts);
  applyTaskDrain(drain);
  return drain;
}
// Stops only an operator drain. A maintenance hold is released through its own
// managed route, so it cannot be lifted by the generic drain endpoint.
export function stopTaskDrain(): { wasActive: boolean } {
  const wasActive = readTaskDrain(new Date()) !== null && taskDrainState !== null;
  taskDrainState = null;
  notifyDrainChanged();
  return { wasActive };
}
export function isIdleTaskDrainActive(): boolean { return Boolean(readTaskDrain(new Date())?.ownerId); }

// Tokens count work until its actual promise settles, including after HTTP
// disconnects and after a cleanup batch has been removed from its input queue.
// The generation also catches work which starts AND finishes during a scan.
let generation = 0;
let active = 0;
const settledListeners = new Set<() => void>();
/** Called (synchronously) whenever the last tracked work finishes. */
export function subscribeIdleWorkSettled(listener: () => void): () => void {
  settledListeners.add(listener);
  return () => { settledListeners.delete(listener); };
}
export function beginIdleTrackedWork(): () => void {
  generation++;
  active++;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    active--;
    generation++;
    if (active === 0) for (const listener of settledListeners) {
      try { listener(); } catch { /* a listener never blocks work accounting */ }
    }
  };
}
export function trackIdleWork<T>(work: Promise<T>): Promise<T> {
  const finish = beginIdleTrackedWork();
  return work.finally(finish);
}
export function idleWorkSnapshot() { return { generation, active }; }
