import { and, eq, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { canonicalExecutionUuid } from "./execution-identity.js";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "./native-local-process-stop.js";
import { LEGACY_WORKSPACE_RECOVERY_SCHEMA } from "./workspace-restore-recovery-state.js";

/** A rejected queued assignment is not an interrupted execution. Historical
 * receipts are exempt only when retained evidence proves dispatch never began.
 * This grants no invitation authority and does not bypass later-run ordering. */
export async function isPreDispatchAssignmentRejectionVerified(db: Db, run: typeof heartbeatRuns.$inferSelect): Promise<boolean> {
  if (run.runtimeMode !== "legacy" || run.status !== "cancelled" || run.errorCode !== "issue_assignee_changed") return false;
  const [verified] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id),
    sql`coalesce(
      ${heartbeatRuns.runtimeMode} = 'legacy' AND ${heartbeatRuns.status} = 'cancelled'
      AND ${heartbeatRuns.finishedAt} IS NOT NULL
      AND ${heartbeatRuns.errorCode} = 'issue_assignee_changed'
      AND ${heartbeatRuns.resultJson}->>'stopReason' = 'issue_assignee_changed'
      AND ${heartbeatRuns.resultJson}->>'timeoutSource' = 'stale_queued_run_gate'
      AND ${canonicalExecutionUuid(sql`${heartbeatRuns.contextSnapshot}->>'issueId'`)} IS NOT NULL
      AND (${heartbeatRuns.issueId} IS NULL OR ${heartbeatRuns.issueId}
        = ${canonicalExecutionUuid(sql`${heartbeatRuns.contextSnapshot}->>'issueId'`)})
      AND ${heartbeatRuns.startedAt} IS NULL AND ${heartbeatRuns.runtimeModeResolvedAt} IS NULL
      AND ${heartbeatRuns.processPid} IS NULL AND ${heartbeatRuns.processGroupId} IS NULL
      AND ${heartbeatRuns.processStartedAt} IS NULL AND ${heartbeatRuns.nativeIssueId} IS NULL
      AND ${heartbeatRuns.nativeSessionId} IS NULL AND ${heartbeatRuns.sessionIdAfter} IS NULL
      AND ${heartbeatRuns.controllerBootId} IS NULL AND ${heartbeatRuns.controllerLeaseExpiresAt} IS NULL
      AND ${heartbeatRuns.executionStage} IS NULL
      AND ${heartbeatRuns.runnerProfileJson}->>'nativeWorkspaceFinalizationOwner' IS NULL
      AND coalesce(${heartbeatRuns.resultJson}->>'workspaceRestoreFailure', '') <> 'restore_unsafe_archive'
      AND coalesce(${heartbeatRuns.resultJson}->'workspaceRestoreRecovery'->>'schema', '') <> ${LEGACY_WORKSPACE_RECOVERY_SCHEMA}
      AND NOT EXISTS (SELECT 1 FROM ${environmentLeases}
        WHERE ${environmentLeases.companyId} = ${heartbeatRuns.companyId}
          AND ${environmentLeases.heartbeatRunId} = ${heartbeatRuns.id})
      AND NOT EXISTS (SELECT 1 FROM ${nativeRunFinalizations}
        WHERE ${nativeRunFinalizations.companyId} = ${heartbeatRuns.companyId}
          AND ${nativeRunFinalizations.runId} = ${heartbeatRuns.id})
      AND NOT EXISTS (SELECT 1 FROM ${heartbeatRunEvents}
        WHERE ${heartbeatRunEvents.companyId} = ${heartbeatRuns.companyId}
          AND ${heartbeatRunEvents.runId} = ${heartbeatRuns.id}
          AND (${heartbeatRunEvents.sourceEventId} IS NOT NULL OR ${heartbeatRunEvents.eventType} IN
            ('adapter.invoke', ${PROCESS_START_REQUESTED}, ${PROCESS_IDENTITY_RECORDED}, 'harness.ready',
             'session.started', 'session.resumed', 'session.updated', 'turn.started',
             'provider.event', 'provider.rpc_result', 'tool.execution.started'))), false)`,
  )).limit(1);
  return Boolean(verified);
}
