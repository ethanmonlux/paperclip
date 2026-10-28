import { describe, expect, it } from "vitest";

import { ACPX_STALLED_TOOL_MARGIN_MS, ACPX_STALLED_TOOL_TIMEOUT_MS } from "./constants.js";
import {
  ACPX_QUIET_TURN_TIMEOUT_MS,
  decideQuietTurn,
  formatQuietTurnMessage,
  resolveQuietTurnTimeoutMs,
  type QuietTurnEvidence,
} from "./quiet-turn-watchdog.js";

/**
 * A turn that is silent well past its bound, owned by nobody, waiting on
 * nothing, behind a readable live provider. Every test below changes exactly
 * one field, so each assertion isolates one clause of the decision.
 */
function quietAndCancellable(overrides: Partial<QuietTurnEvidence> = {}): QuietTurnEvidence {
  return {
    silentMs: 60 * 60 * 1000,
    timeoutMs: 45 * 60 * 1000,
    observedEventCount: 0,
    pendingToolCount: 0,
    pendingPermissionCount: 0,
    stopAlreadyRequested: false,
    provider: "alive",
    channelLost: false,
    toolInventoryComplete: true,
    ...overrides,
  };
}

describe("resolveQuietTurnTimeoutMs", () => {
  it("clears the stalled-tool bound by the stalled-tool margin", () => {
    // Both watchdogs can apply to a turn with a pending tool call. The
    // stalled-tool one names the offending call, so it must always be able to
    // fire first; the quiet bound stays above it by the margin.
    expect(resolveQuietTurnTimeoutMs(ACPX_STALLED_TOOL_TIMEOUT_MS)).toBeGreaterThanOrEqual(
      ACPX_STALLED_TOOL_TIMEOUT_MS + ACPX_STALLED_TOOL_MARGIN_MS,
    );
  });

  it("keeps the gap when the environment raises the stalled-tool bound past the default", () => {
    const raised = 4 * 60 * 60 * 1000;
    expect(resolveQuietTurnTimeoutMs(raised)).toBe(raised + ACPX_STALLED_TOOL_MARGIN_MS);
  });

  it("falls back to its own default when the stalled-tool watchdog is disabled", () => {
    expect(resolveQuietTurnTimeoutMs(0)).toBe(ACPX_QUIET_TURN_TIMEOUT_MS);
    expect(resolveQuietTurnTimeoutMs(-1)).toBe(ACPX_QUIET_TURN_TIMEOUT_MS);
  });
});

describe("decideQuietTurn: it ends a genuinely quiet turn", () => {
  it("cancels a live provider that said nothing for the whole bound", () => {
    // The FAC-32 shape: the provider accepted the prompt, stayed connected,
    // and emitted no ACP event at all.
    expect(decideQuietTurn(quietAndCancellable())).toEqual({
      action: "cancel",
      reason: "provider_quiet",
      effects: "settled",
    });
  });

  it("cancels a provider that exited without delivering a terminal result", () => {
    expect(decideQuietTurn(quietAndCancellable({ provider: "exited" }))).toEqual({
      action: "cancel",
      reason: "provider_exited_silently",
      effects: "settled",
    });
  });

  it("cancels a turn that went quiet after doing some work", () => {
    expect(decideQuietTurn(quietAndCancellable({ observedEventCount: 12 }))).toMatchObject({
      action: "cancel",
      reason: "provider_quiet",
    });
  });

  it("fires exactly at the bound, not only past it", () => {
    expect(decideQuietTurn(quietAndCancellable({ silentMs: 45 * 60 * 1000 }))).toMatchObject({
      action: "cancel",
    });
  });
});

describe("decideQuietTurn: active output and legitimate waits do not false-trigger", () => {
  it("waits while the turn is still inside its bound", () => {
    // Every runtime event resets `silentMs`, so a provider producing useful
    // output never reaches the bound.
    expect(decideQuietTurn(quietAndCancellable({ silentMs: 45 * 60 * 1000 - 1 }))).toEqual({
      action: "wait",
      reason: "within_timeout",
    });
  });

  it("waits a silent turn that still owes a pending tool call", () => {
    // A long Bash command or a live subagent looks identical to this watchdog.
    // The stalled-tool watchdog knows which call is stuck and reports it.
    expect(decideQuietTurn(quietAndCancellable({ pendingToolCount: 1 }))).toEqual({
      action: "wait",
      reason: "stalled_tool_owned",
    });
  });

  it("waits when another owner already asked the turn to end", () => {
    expect(decideQuietTurn(quietAndCancellable({ stopAlreadyRequested: true }))).toEqual({
      action: "wait",
      reason: "stop_already_requested",
    });
  });

  it("waits when the duplex-loss seam owns the turn", () => {
    expect(decideQuietTurn(quietAndCancellable({ channelLost: true }))).toEqual({
      action: "wait",
      reason: "duplex_loss_owned",
    });
  });

  it("prefers the more specific owner even when several conditions overlap", () => {
    // A stop request outranks a channel loss, which outranks a pending tool.
    expect(
      decideQuietTurn(
        quietAndCancellable({ stopAlreadyRequested: true, channelLost: true, pendingToolCount: 3 }),
      ),
    ).toEqual({ action: "wait", reason: "stop_already_requested" });
    expect(
      decideQuietTurn(quietAndCancellable({ channelLost: true, pendingToolCount: 3 })),
    ).toEqual({ action: "wait", reason: "duplex_loss_owned" });
  });
});

describe("decideQuietTurn: failed and unknown states hold rather than cancel", () => {
  it("holds a silent turn that is waiting on an operator permission answer", () => {
    // Waiting on a human has no bound the host may impose. The hold keeps the
    // silence visible without ending the turn.
    expect(
      decideQuietTurn(quietAndCancellable({ pendingToolCount: 0, pendingPermissionCount: 1 })),
    ).toEqual({ action: "hold", reason: "awaiting_permission" });
  });

  it("holds when the host cannot read the provider process", () => {
    // A sandbox/remote lane owns no local child. Unknown liveness is not
    // evidence the provider is wedged, so it never authorizes a cancel.
    expect(decideQuietTurn(quietAndCancellable({ provider: "unknown" }))).toEqual({
      action: "hold",
      reason: "provider_liveness_unknown",
    });
  });

  it("reports unknown effects when the turn's tool inventory is incomplete", () => {
    // Nothing is pending, but a receipt the host could not attribute means a
    // successor might duplicate an effect. The cancel still happens; the
    // effects label is what stops the automatic replay.
    expect(decideQuietTurn(quietAndCancellable({ toolInventoryComplete: false }))).toEqual({
      action: "cancel",
      reason: "provider_quiet",
      effects: "unknown",
    });
  });

  it("never reports settled effects while the inventory is incomplete, on either cancel reason", () => {
    for (const provider of ["alive", "exited"] as const) {
      expect(
        decideQuietTurn(quietAndCancellable({ provider, toolInventoryComplete: false })),
      ).toMatchObject({ action: "cancel", effects: "unknown" });
    }
  });
});

describe("formatQuietTurnMessage", () => {
  it("explains a quiet live provider and its settled effects", () => {
    const message = formatQuietTurnMessage({
      reason: "provider_quiet",
      silentMs: 45 * 60 * 1000,
      observedEventCount: 0,
      effects: "settled",
    });
    expect(message).toContain("sent no activity for 45 minutes");
    expect(message).toContain("never sent any activity this turn");
    expect(message).toContain("Every action it took has a known outcome.");
  });

  it("says the run holds when effects are unknown", () => {
    const message = formatQuietTurnMessage({
      reason: "provider_exited_silently",
      silentMs: 50 * 60 * 1000,
      observedEventCount: 1,
      effects: "unknown",
    });
    expect(message).toContain("exited without delivering a result");
    expect(message).toContain("It sent 1 event earlier in the turn");
    expect(message).toContain("holds instead of retrying automatically");
  });

  it("carries only counts and durations, never provider text", () => {
    // The message reaches the run log and the task feed, so it must stay free
    // of prompts, tool arguments, and provider output.
    const message = formatQuietTurnMessage({
      reason: "provider_quiet",
      silentMs: 46 * 60 * 1000,
      observedEventCount: 3,
      effects: "settled",
    });
    expect(message).toMatch(/^[\w\s.,()-]+$/);
  });
});
