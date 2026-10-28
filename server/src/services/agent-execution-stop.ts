import { readProcessStartedAt } from "./hot-restart.js";
import { claimedAdapterType, isConversationAdapter, runUsedConversationAdapter } from "./conversation-continuation.js";
import { and, eq, inArray, isNotNull, isNull, like, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { hasNativeLocalProcessStop, PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { isCancelledNativeStartup } from "./cancelled-native-startup.js";
import { legacyControllerBootId } from "./legacy-controller-lease.js";

async function hasReconciledLegacyPreDispatchStop(db: Db, run: typeof heartbeatRuns.$inferSelect, hasCoordinator: boolean) {
  if (run.runtimeMode !== "legacy" || run.status !== "cancelled" ||
      run.errorCode !== "continuation_task_ownership_changed" || run.executionStage !== "preparing" ||
      !run.startedAt || !run.finishedAt || run.processPid || run.processGroupId || run.processStartedAt ||
      !run.controllerBootId || run.controllerBootId === legacyControllerBootId ||
      !run.controllerLeaseExpiresAt || run.controllerLeaseExpiresAt > new Date() ||
      run.nativeIssueId || run.nativeSessionId || run.runtimeModeResolvedAt || run.runnerInstanceId ||
      run.externalRunId || run.sessionIdAfter || run.driverKind || run.completionContractId || run.nativePhase ||
      run.lastOutputAt || run.lastOutputSeq > 0 || run.stdoutExcerpt || run.stderrExcerpt || hasCoordinator ||
      !isConversationAdapter(claimedAdapterType(run) ?? "")) return false;
  const issueId = run.contextSnapshot?.issueId;
  if (typeof issueId !== "string" || !isUuidLike(issueId) ||
      (run.issueId !== null && run.issueId !== issueId) ||
      (run.contextSnapshot?.taskId !== undefined && run.contextSnapshot.taskId !== issueId)) return false;
  const actions = await db.select({ evidence: issueRecoveryActions.evidence, resolvedAt: issueRecoveryActions.resolvedAt })
    .from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
      eq(issueRecoveryActions.returnOwnerAgentId, run.agentId), eq(issueRecoveryActions.kind, "active_run_watchdog"),
      eq(issueRecoveryActions.cause, "legacy_execution_requires_reconciliation"), eq(issueRecoveryActions.status, "resolved"),
      eq(issueRecoveryActions.outcome, "handed_back"), sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
    ));
  if (!actions.some(action => {
    const decision = action.evidence.executionReconciliation as Record<string, unknown> | undefined;
    const recordedAt = typeof decision?.recordedAt === "string" ? Date.parse(decision.recordedAt) : NaN;
    return decision?.runId === run.id && decision.providerStopped === true && decision.actionOutcome === "not_performed" &&
      typeof decision.outcomeEvidence === "string" && decision.outcomeEvidence.trim().length > 0 &&
      typeof decision.actorId === "string" && decision.actorId.trim().length > 0 &&
      Number.isFinite(recordedAt) && recordedAt >= run.finishedAt!.getTime() &&
      action.resolvedAt !== null && action.resolvedAt.getTime() >= recordedAt;
  })) return false;
  const [execution] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    or(isNotNull(heartbeatRunEvents.sourceEventId), isNotNull(heartbeatRunEvents.sourceInstanceId), isNotNull(heartbeatRunEvents.sourceSeq),
      inArray(heartbeatRunEvents.stream, ["stdout", "stderr"]),
      inArray(heartbeatRunEvents.eventType, ["adapter.invoke", PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED]),
      like(heartbeatRunEvents.eventType, "harness.%"), like(heartbeatRunEvents.eventType, "session.%"),
      like(heartbeatRunEvents.eventType, "turn.%"), like(heartbeatRunEvents.eventType, "provider.%"),
      like(heartbeatRunEvents.eventType, "tool.execution.%")),
  )).limit(1);
  return !execution;
}

/** Cancellation changes admission. Process and lease evidence controls cleanup. */
export async function agentExecutionsHaveStopped(db: Db, agentIds: string[]) {
  if (!agentIds.length) return true;
  const runs = await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, agentIds));
  const runIds = db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, agentIds));
  const leases = await db.select().from(environmentLeases).where(or(
    inArray(environmentLeases.heartbeatRunId, runIds),
    inArray(sql`${environmentLeases.metadata}->>'agentId'`, agentIds),
  ));
  if (leases.some(lease => (!lease.releasedAt && !(lease.status === "retained" && lease.cleanupStatus === "success")) || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed")) return false;
  const coordinators = await db.select().from(nativeRunFinalizations)
    .where(inArray(nativeRunFinalizations.runId, runIds));
  const now = new Date();
  const abandoned = coordinators.filter(row => row.leaseOwner);
  if (abandoned.some(row => !row.leaseExpiresAt || row.leaseExpiresAt > now || row.resultId ||
      runs.find(run => run.id === row.runId)?.status !== "cancelled")) return false;
  const absent = (pid: number) => {
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  };
  for (const coordinator of abandoned) {
    if (!coordinator.controllerPid || absent(coordinator.controllerPid)) continue;
    const observed = await readProcessStartedAt(coordinator.controllerPid).catch(() => null);
    if (!observed || !coordinator.controllerProcessStartedAt ||
        new Date(observed).getTime() === coordinator.controllerProcessStartedAt.getTime()) return false;
  }
  for (const run of runs) {
    if (!["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(run.status)) return false;
    if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()) return false;
    const runLeases = leases.filter(lease => lease.heartbeatRunId === run.id);
    if (runLeases.some(lease => lease.provider && lease.provider !== "local")) {
      if (run.status === "cancelled" && !runLeases.every(hasRemoteTerminationReceipt)) return false;
      continue;
    }
    let processAlive = Boolean(run.processPid && !absent(run.processPid));
    let groupAlive = Boolean(run.processGroupId && !absent(-run.processGroupId));
    if (processAlive && run.processStartedAt) {
      const observed = await readProcessStartedAt(run.processPid!).catch(() => null);
      if (observed && new Date(observed).getTime() !== run.processStartedAt.getTime()) {
        processAlive = false;
        if (run.processGroupId === run.processPid) groupAlive = false;
      }
    }
    if (processAlive || groupAlive) return false;
    if (run.status !== "cancelled" || !run.startedAt) continue;
    if (run.runtimeMode === "native" && !run.processPid && !run.processGroupId &&
        !await hasNativeLocalProcessStop(db, run.companyId, run.id) &&
        !await isCancelledNativeStartup(db, run, coordinators.find(row => row.runId === run.id))) return false;
    if (run.runtimeMode === "legacy" && !run.processPid && !run.processGroupId &&
        (run.resultJson?.executionCancellation as Record<string, unknown> | undefined)?.state !== "acknowledged" &&
        !(run.executionStage === "settled" && !await runUsedConversationAdapter(db, run)) &&
        !await isCancelledNativeStartup(db, run, coordinators.find(row => row.runId === run.id)) &&
        !await hasReconciledLegacyPreDispatchStop(db, run, coordinators.some(row => row.runId === run.id))) return false;
  }
  // Release an expired owner only after its cancelled execution has stop proof.
  for (const coordinator of abandoned) {
    const [cleared] = await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
      .where(and(eq(nativeRunFinalizations.runId, coordinator.runId),
        eq(nativeRunFinalizations.leaseOwner, coordinator.leaseOwner!),
        eq(nativeRunFinalizations.leaseExpiresAt, coordinator.leaseExpiresAt!),
        eq(nativeRunFinalizations.controllerGeneration, coordinator.controllerGeneration),
        eq(nativeRunFinalizations.phase, coordinator.phase), isNull(nativeRunFinalizations.resultId)))
      .returning({ runId: nativeRunFinalizations.runId });
    if (!cleared) return false;
  }
  return true;
}
