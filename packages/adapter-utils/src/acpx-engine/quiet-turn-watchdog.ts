// The quiet-turn watchdog.
//
// The CLI lane bounds a silent provider with `createCodexOutputInactivityMonitor`:
// no stdout/stderr chunk and no process activity for N minutes ends the child.
// The ACP lane had no equivalent. Its two existing seams each need a *specific*
// signal the quiet case never produces:
//
//   - the duplex-loss seam needs a latched sandbox control-channel loss, and a
//     quiet provider's channel is healthy;
//   - the stalled-tool watchdog needs at least one *pending tool call* that
//     stopped updating, and a quiet provider that emitted no tool call at all
//     leaves its pending set empty, so that watchdog returns without a finding.
//
// With `DEFAULT_ACP_ENGINE_TIMEOUT_SEC` at 0 there is also no wall-clock
// backstop, so a provider that accepts the prompt and then says nothing holds
// the turn open indefinitely and only an operator can end it.
//
// This module is the missing bound. It is a pure decision over the evidence the
// engine already collects; it owns no timer, cancels nothing, and reads no
// provider text. The engine ticks it and acts on the returned action, so the
// policy is testable without spawning a provider or waiting real minutes.
//
// The decision is deliberately conservative. Ending a turn destroys work, so
// every reading that is merely *consistent* with silence — another owner already
// stopping the turn, a tool call still pending, an operator permission prompt
// outstanding, or an unreadable provider process — resolves to `wait` or `hold`
// rather than `cancel`. Only a turn that is silent past its bound, owned by
// nobody else, waiting on nothing legitimate, and backed by a readable provider
// state is cancelled.

import { ACPX_STALLED_TOOL_MARGIN_MS, ACPX_STALLED_TOOL_TIMEOUT_MS } from "./constants.js";

/**
 * The default bound on how long an ACP turn may produce no runtime event of any
 * kind before the host ends it. It sits above the stalled-tool bound so the
 * narrower watchdog, which can name the offending tool call, always reports
 * first on a turn where both could apply.
 */
export const ACPX_QUIET_TURN_TIMEOUT_MS = 45 * 60 * 1000;

/** How often the engine re-evaluates a running turn's silence. */
export const ACPX_QUIET_TURN_CHECK_INTERVAL_MS = 60_000;

export const ACPX_QUIET_TURN_ERROR_CODE = "acpx_quiet_turn";

/**
 * Whether the provider process backing this turn is readable, and if so whether
 * it is still running. `unknown` covers every case where the host cannot read
 * the process directly — a sandbox/remote lane with no local child, or a launch
 * that never reported an identity. It is not a synonym for "gone".
 */
export type QuietTurnProviderLiveness = "alive" | "exited" | "unknown";

/**
 * One tick's worth of evidence. Every field is already tracked by the engine for
 * its own diagnostics; the watchdog adds no new instrumentation.
 */
export interface QuietTurnEvidence {
  /** Time since the last runtime event of any kind, in milliseconds. */
  readonly silentMs: number;
  /** The resolved bound for this turn. */
  readonly timeoutMs: number;
  /** Runtime events observed so far this turn. Zero means the provider never spoke. */
  readonly observedEventCount: number;
  /** Tool calls with no settled outcome. The stalled-tool watchdog owns these. */
  readonly pendingToolCount: number;
  /** Pending tool calls whose permission request reached Paperclip and awaits an answer. */
  readonly pendingPermissionCount: number;
  /** Another owner (operator stop, stalled-tool watchdog, duplex loss) already asked the turn to end. */
  readonly stopAlreadyRequested: boolean;
  /** Whether the host can read the provider process, and what it reads. */
  readonly provider: QuietTurnProviderLiveness;
  /** A latched sandbox duplex control-channel loss. That seam owns the turn. */
  readonly channelLost: boolean;
  /**
   * Whether every action this turn took has a known outcome. False when the
   * runtime flattened a receipt the host could not attribute, which makes the
   * turn's effects unknown even with nothing pending.
   */
  readonly toolInventoryComplete: boolean;
}

/** Why a tick declined to act. The turn keeps running. */
export type QuietTurnWaitReason =
  | "within_timeout"
  | "stop_already_requested"
  | "duplex_loss_owned"
  | "stalled_tool_owned";

/**
 * Why a tick declined to act even though the turn is silent past its bound. The
 * turn keeps running and the reason is reported, so the silence stays visible
 * rather than being resolved by a guess.
 */
export type QuietTurnHoldReason = "awaiting_permission" | "provider_liveness_unknown";

/** Why a tick ended the turn. */
export type QuietTurnCancelReason = "provider_quiet" | "provider_exited_silently";

/**
 * What the turn's effects are known to be at the moment of cancellation.
 * `settled` means every action the provider took has a known outcome, so a
 * successor cannot duplicate one. `unknown` means it might not, so the run must
 * hold rather than authorize replay.
 */
export type QuietTurnEffects = "settled" | "unknown";

export type QuietTurnDecision =
  | { readonly action: "wait"; readonly reason: QuietTurnWaitReason }
  | { readonly action: "hold"; readonly reason: QuietTurnHoldReason }
  | {
      readonly action: "cancel";
      readonly reason: QuietTurnCancelReason;
      readonly effects: QuietTurnEffects;
    };

/**
 * Resolve the quiet-turn bound. It always clears the stalled-tool bound by
 * `ACPX_STALLED_TOOL_MARGIN_MS`, so an environment that raises the stalled-tool
 * timeout (via `MCP_TOOL_TIMEOUT` / `BASH_MAX_TIMEOUT_MS` headroom) cannot push
 * it past the quiet bound and let the coarser watchdog pre-empt the one that
 * can name the stuck tool call.
 *
 * A non-positive `stalledToolTimeoutMs` means the stalled-tool watchdog is
 * disabled; the quiet bound then stands on its own default.
 */
export function resolveQuietTurnTimeoutMs(
  stalledToolTimeoutMs: number = ACPX_STALLED_TOOL_TIMEOUT_MS,
): number {
  if (!(stalledToolTimeoutMs > 0)) return ACPX_QUIET_TURN_TIMEOUT_MS;
  return Math.max(ACPX_QUIET_TURN_TIMEOUT_MS, stalledToolTimeoutMs + ACPX_STALLED_TOOL_MARGIN_MS);
}

/**
 * Decide what a running turn's silence means. Pure: same evidence, same answer.
 *
 * The clause order encodes the precedence. Ownership first (someone else is
 * already ending this turn), then the bound itself, then the legitimate waits,
 * then the provider read. Only the last clause ends a turn.
 */
export function decideQuietTurn(evidence: QuietTurnEvidence): QuietTurnDecision {
  // Another owner already asked the turn to end. A second cancel would race it
  // and could overwrite the more specific reason it will report.
  if (evidence.stopAlreadyRequested) return { action: "wait", reason: "stop_already_requested" };
  // The duplex-loss seam cancels and arms its own fail-fast deadline. Silence
  // on a lost channel is that seam's finding, not this one's.
  if (evidence.channelLost) return { action: "wait", reason: "duplex_loss_owned" };
  // Not silent long enough. Active useful output keeps resetting `silentMs`, so
  // a working provider never reaches the bound.
  if (!(evidence.silentMs >= evidence.timeoutMs)) return { action: "wait", reason: "within_timeout" };
  // A pending tool call is a legitimate wait with a narrower owner. A long Bash
  // command, a live subagent, or an MCP call in flight all look identical to
  // this watchdog; the stalled-tool watchdog knows which call is stuck and
  // reports it by kind and silent time.
  if (evidence.pendingToolCount > 0) return { action: "wait", reason: "stalled_tool_owned" };
  // An outstanding permission prompt is a legitimate wait on a *human*, which
  // has no bound the host may impose. Hold it visibly instead.
  if (evidence.pendingPermissionCount > 0) return { action: "hold", reason: "awaiting_permission" };
  // The host cannot read the provider process on this lane, so it cannot
  // distinguish a wedged provider from one the sandbox is still scheduling.
  // Unknown liveness holds; it never authorizes a cancel.
  if (evidence.provider === "unknown") return { action: "hold", reason: "provider_liveness_unknown" };
  // Effects are settled only when nothing is pending (guaranteed above) *and*
  // every action the turn took was attributable. Anything less is unknown, and
  // an unknown effect must not authorize a replay.
  const effects: QuietTurnEffects = evidence.toolInventoryComplete ? "settled" : "unknown";
  // The provider exited without delivering a terminal result. The turn can
  // never complete; end it now rather than hold a dead session open.
  if (evidence.provider === "exited") {
    return { action: "cancel", reason: "provider_exited_silently", effects };
  }
  // A live provider that has emitted nothing for the whole bound, owes no tool
  // call and awaits no human. This is the FAC-32 shape.
  return { action: "cancel", reason: "provider_quiet", effects };
}

/**
 * The operator-facing explanation. It carries only the closed reason enum, the
 * silent time, and counts — never provider text, prompts, or tool arguments.
 */
export function formatQuietTurnMessage(input: {
  readonly reason: QuietTurnCancelReason;
  readonly silentMs: number;
  readonly observedEventCount: number;
  readonly effects: QuietTurnEffects;
}): string {
  const minutes = Math.round(input.silentMs / 60_000);
  const subject =
    input.reason === "provider_exited_silently"
      ? "The provider process exited without delivering a result"
      : "The provider stayed connected but sent no activity";
  const spoke =
    input.observedEventCount === 0
      ? "It never sent any activity this turn"
      : `It sent ${input.observedEventCount} event${input.observedEventCount === 1 ? "" : "s"} earlier in the turn`;
  const effects =
    input.effects === "settled"
      ? "Every action it took has a known outcome."
      : "Some actions have no confirmed outcome, so this run holds instead of retrying automatically.";
  return (
    `${subject} for ${minutes} minutes, so Paperclip ended the turn instead of waiting indefinitely. ` +
    `${spoke}. ${effects}`
  );
}
