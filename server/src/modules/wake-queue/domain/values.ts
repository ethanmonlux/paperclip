// Small, shared domain values for the wake-queue module: string readers, the
// two failed-run codes, and the recovery retry reason they gate. The
// application and adapter layers both need these, so they live here once
// instead of twice.

export function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function parseObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export const WORKSPACE_VALIDATION_FAILURE_CODE = "workspace_validation_failed";
export const CONFIGURATION_INCOMPLETE_FAILURE_CODE = "configuration_incomplete";
export const EXECUTION_REVIEW_PARTICIPANT_RECOVERY_RETRY_REASON = "execution_review_participant_recovery";

export function isWorkspaceValidationFailedRun(run: { errorCode: string | null }): boolean {
  return run.errorCode === WORKSPACE_VALIDATION_FAILURE_CODE;
}

export function isConfigurationIncompleteFailedRun(run: { errorCode: string | null }): boolean {
  return run.errorCode === CONFIGURATION_INCOMPLETE_FAILURE_CODE || run.errorCode === "model_not_found" ||
    run.errorCode === "native_provider_model_rejected";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Typed retirement code for a deferred addressed wake whose invitation left `pending`. */
export const INTERACTION_NO_LONGER_PENDING_CODE = "interaction_no_longer_pending";

/**
 * The interaction id an addressed-invitation wake names, or null for every
 * other wake. Only the wake produced when an addressed card is created
 * (`issue.interaction.created` / `interaction_pending`) qualifies; resolved
 * continuations and ordinary comment wakes keep their own paths. Only a
 * well-formed UUID qualifies, so the uuid-typed lookup can never abort the
 * release transaction.
 */
export function readAddressedInteractionWakeId(context: Record<string, unknown>): string | null {
  if (context.source !== "issue.interaction.created" || context.wakeReason !== "interaction_pending") return null;
  // Same shape check as the dispatch gate's read; a malformed id is left to its normal path.
  const interactionId = readNonEmptyString(context.interactionId);
  return interactionId && UUID.test(interactionId) ? interactionId : null;
}
