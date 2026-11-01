import { describe, expect, it } from "vitest";
import { cancellationResultJson, canContinueCancelledRun, isUnexpectedRunCancellation, requestedRunCancellation } from "./run-cancellation.js";

describe("cancellation provenance", () => {
  const run = { status: "cancelled", runtimeMode: "legacy" as const, startedAt: new Date(0), finishedAt: new Date(1),
    error: "Cancelled", errorCode: "cancelled", resultJson: null };
  it("preserves operator intent over adapter completion metadata", () => {
    const cancellation = requestedRunCancellation({ cancelledByUserId: "board", cancelledByActorType: "user" }, "Stop");
    const resultJson = cancellationResultJson({ ...run, resultJson: { cancellation } }, "cancelled", { status: "cancelled" });
    expect(resultJson?.cancellation).toEqual(cancellation);
    expect(isUnexpectedRunCancellation({ ...run, resultJson })).toBe(false);
    expect(canContinueCancelledRun({ ...run, resultJson })).toBe(false);
  });
  // STA-21 stage 12: a lease-loss attribution never displaces a recorded Stop,
  // but does replace an earlier unattributed stop.
  const leaseLoss = { source: "controller_lease", expected: false, initiator: { type: "system" },
    reason: "Legacy controller lease lost (renewal_error)", recordedAt: new Date(2).toISOString() };
  it("keeps a recorded operator Stop over a later lease-loss attribution", () => {
    const cancellation = requestedRunCancellation({ cancelledByUserId: "board", cancelledByActorType: "user" }, "Stop");
    const resultJson = cancellationResultJson({ ...run, resultJson: { cancellation } }, "cancelled", { cancellation: leaseLoss });
    expect(resultJson?.cancellation).toEqual(cancellation);
  });
  it("attributes a lease loss over an earlier unattributed stop", () => {
    const unknown = { source: "unknown", expected: false, initiator: { type: "system" },
      reason: "Execution stopped without a recorded cancellation request", recordedAt: new Date(1).toISOString() };
    const resultJson = cancellationResultJson({ ...run, resultJson: { cancellation: unknown } }, "cancelled", { cancellation: leaseLoss });
    expect(resultJson?.cancellation).toEqual(leaseLoss);
    expect(isUnexpectedRunCancellation({ ...run, resultJson })).toBe(true);
    expect(canContinueCancelledRun({ ...run, resultJson })).toBe(false);
  });
  it("records queue interruption and shutdown as expected system actions", () => {
    expect(requestedRunCancellation({ queuedCommentInterruptQueueId: "queue", cancelledByUserId: "board" }, "Send messages"))
      .toMatchObject({ source: "queued_message", expected: true, initiator: { type: "user", id: "board" } });
    expect(cancellationResultJson(run, "interrupted", {}, "server_shutdown_interrupted")?.cancellation)
      .toMatchObject({ source: "shutdown", expected: true });
    expect(requestedRunCancellation({ queuedCommentInterruptQueueId: "queue", interruptedByActorType: "user", interruptedByActorId: "board" }, "Send messages"))
      .toMatchObject({ source: "queued_message", initiator: { type: "user", id: "board" } });
  });
  it("requires positive provider evidence and a complete empty tool inventory for saved input", () => {
    const resultJson = cancellationResultJson(run, "cancelled", { status: "cancelled", acpToolInventoryComplete: true, acpPendingToolCount: 0 });
    expect(resultJson?.cancellation).toMatchObject({ source: "provider", expected: false });
    expect(canContinueCancelledRun({ ...run, resultJson })).toBe(true);
    expect(canContinueCancelledRun({ ...run, resultJson: { ...resultJson, acpPendingToolCount: 1 } })).toBe(false);
    expect(canContinueCancelledRun({ ...run, resultJson: { ...resultJson, acpToolInventoryComplete: false } })).toBe(false);
    expect(canContinueCancelledRun({ ...run, resultJson: {} })).toBe(false);
    expect(isUnexpectedRunCancellation(run)).toBe(true);
    expect(isUnexpectedRunCancellation({ ...run, resultJson: {
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    } })).toBe(false);
  });
});
