import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getTaskDrainStatus,
  resolveHeartbeatSchedulingSuppression,
  startTaskDrain,
  stopTaskDrain,
} from "../services/heartbeat.ts";
import {
  applyMaintenanceHold,
  readMaintenanceHold,
  runMaintenanceDrainDeadline,
  setMaintenanceDrainDeadlineHandler,
  subscribeMaintenanceHoldExpiry,
  subscribeTaskDrainExpiry,
  type MaintenanceHoldState,
} from "../services/task-admission.js";

describe("heartbeat task drain", () => {
  afterEach(() => {
    stopTaskDrain();
    vi.useRealTimers();
  });

  it("start_task_drain_suppresses_admission", () => {
    startTaskDrain({});
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({
      suppressed: true,
      reason: "task_drain",
    });
  });

  it("stop_task_drain_restores_admission", () => {
    startTaskDrain({});
    expect(stopTaskDrain()).toEqual({ wasActive: true });
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({
      suppressed: false,
      reason: null,
    });
    expect(stopTaskDrain()).toEqual({ wasActive: false });
  });

  it("null_ttl_produces_no_expiry", () => {
    const { expiresAt } = startTaskDrain({ ttlMs: null });
    expect(expiresAt).toBeNull();
    expect(getTaskDrainStatus().expiresAt).toBeNull();
  });

  it("an_expired_ttl_ends_the_drain_and_restores_admission", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    startTaskDrain({ ttlMs: 1000 });
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({
      suppressed: true,
      reason: "task_drain",
    });

    vi.setSystemTime(new Date("2026-01-01T00:00:01.001Z"));
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({
      suppressed: false,
      reason: null,
    });
    expect(getTaskDrainStatus().draining).toBe(false);
  });

  it("status_reports_quiescent_when_both_promise_sets_are_empty", () => {
    startTaskDrain({});
    const status = getTaskDrainStatus();
    expect(status.draining).toBe(true);
    expect(status.activeRuns).toBe(0);
    expect(status.pendingWakes).toBe(0);
    expect(status.quiescent).toBe(true);
  });

});

describe("maintenance hold admission slot (FAC-840 C1)", () => {
  const hold = (overrides: Partial<MaintenanceHoldState> = {}): MaintenanceHoldState => ({
    id: "hold-1",
    startedAt: new Date(Date.now() - 60_000),
    drainDeadlineAt: new Date(Date.now() - 1_000),
    expiresAt: new Date(Date.now() + 60 * 60_000),
    parkedAt: null,
    ...overrides,
  });
  const detach: Array<() => void> = [];
  afterEach(() => {
    for (const fn of detach.splice(0)) fn();
    applyMaintenanceHold(null);
    stopTaskDrain();
  });

  it("holds admission, and the generic drain stop cannot lift it", () => {
    applyMaintenanceHold(hold());
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({ suppressed: true, reason: "task_drain" });
    expect(stopTaskDrain()).toEqual({ wasActive: false });
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({ suppressed: true, reason: "task_drain" });
  });

  it("parks once at the drain deadline and backs off after a failed attempt", async () => {
    applyMaintenanceHold(hold());
    const handler = vi.fn().mockRejectedValueOnce(new Error("database unavailable")).mockResolvedValue(undefined);
    detach.push(setMaintenanceDrainDeadlineHandler(handler));
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      expect(await runMaintenanceDrainDeadline(new Date())).toBe(false);
      expect(handler).toHaveBeenCalledTimes(1);
      // The retry waits a minute instead of spinning.
      expect(await runMaintenanceDrainDeadline(new Date())).toBe(false);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(await runMaintenanceDrainDeadline(new Date(Date.now() + 61_000))).toBe(true);
      expect(handler).toHaveBeenCalledTimes(2);
      expect(readMaintenanceHold(new Date())?.parkedAt).toBeInstanceOf(Date);
      expect(await runMaintenanceDrainDeadline(new Date(Date.now() + 120_000))).toBe(false);
      expect(handler).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not park before the drain deadline", async () => {
    applyMaintenanceHold(hold({ drainDeadlineAt: new Date(Date.now() + 60_000) }));
    const handler = vi.fn().mockResolvedValue(undefined);
    detach.push(setMaintenanceDrainDeadlineHandler(handler));
    expect(await runMaintenanceDrainDeadline(new Date())).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("auto-releases at expiry through the hold's own listener only", () => {
    const expired = vi.fn();
    const generic = vi.fn();
    detach.push(subscribeMaintenanceHoldExpiry(expired));
    detach.push(subscribeTaskDrainExpiry(generic));
    applyMaintenanceHold(hold({ expiresAt: new Date(Date.now() - 1) }));
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({ suppressed: false, reason: null });
    expect(expired).toHaveBeenCalledWith(expect.objectContaining({ id: "hold-1" }));
    expect(generic).not.toHaveBeenCalled();
    expect(readMaintenanceHold(new Date())).toBeNull();
  });
});
