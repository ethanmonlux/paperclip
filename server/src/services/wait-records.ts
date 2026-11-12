/**
 * Server-evaluated wait records (FAC-840 wait contract).
 *
 * An issue monitor is the task's wait record: `kind`, `target`, `timeoutAt`
 * (deadline) and `recoveryPolicy` (onExpire). `external_service` monitors wake
 * the owner at nextCheckAt so the owner can check. `ci` and `pr_mergeable`
 * monitors name a GitHub object that Paperclip reads itself on every due
 * check, so the owner is woken only when the wait resolves or needs action:
 *
 * - `ci` (exact repo + SHA): check runs and workflow runs for that SHA. Any
 *   queued or running run means CI started; slow CI keeps waiting and never
 *   expires. A completed set wakes the owner with passed/failed. A startup
 *   failure, `action_required`, or a workflow run with zero jobs wakes the
 *   owner now. A conflicting PR (`mergeable_state: dirty`) wakes the owner to
 *   update the base before missing CI is classified. Only when nothing has
 *   started by the no-start deadline (pushedAt + 10 minutes, or timeoutAt)
 *   does the record expire through its recoveryPolicy.
 * - `pr_mergeable` (repo + PR): resolves when GitHub reports the PR
 *   mergeable, closed, or merged; a conflict keeps waiting until the deadline.
 *
 * When GitHub cannot be read, the record degrades to an ordinary monitor wake
 * so a wait is never silently extended.
 */
import type {
  IssueExecutionMonitorPolicy,
  IssueWaitObservation,
  IssueWaitObservationState,
  IssueWaitTarget,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { ghFetch } from "./github-fetch.js";

export const SERVER_EVALUATED_WAIT_KINDS = ["ci", "pr_mergeable"] as const;
export const CI_WAIT_POLL_MS = 2 * 60_000;
export const PR_MERGEABLE_WAIT_POLL_MS = 5 * 60_000;
/** Nothing started this long after the push: CI never started. */
export const CI_NO_START_DEADLINE_MS = 10 * 60_000;
/** Queued this long with nothing in progress: report once, keep waiting. */
export const CI_QUEUED_REPORT_MS = 30 * 60_000;
/** Default deadline for a PR-mergeability wait recorded without one. */
export const PR_MERGEABLE_DEFAULT_DEADLINE_MS = 24 * 60 * 60_000;
const GITHUB_TIMEOUT_MS = 8_000;
const GITHUB_PAGE_SIZE = 100;
const MAX_WORKFLOW_JOB_PAGES = 10;

const ACTIVE_WORKFLOW_STATUSES = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]);

export function isServerEvaluatedWaitKind(kind: string | null | undefined): kind is (typeof SERVER_EVALUATED_WAIT_KINDS)[number] {
  return kind === "ci" || kind === "pr_mergeable";
}

/**
 * Validate a wait record before it is saved and fill server defaults: a CI
 * wait without pushedAt starts its no-start deadline now, and a PR wait
 * without a deadline gets one day.
 */
export function prepareWaitRecordMonitor<T extends Pick<IssueExecutionMonitorPolicy, "kind" | "target" | "timeoutAt" | "nextCheckAt">>(
  monitor: T,
  now = new Date(),
): T {
  const target = monitor.target ?? null;
  if (!isServerEvaluatedWaitKind(monitor.kind)) {
    if (target) throw unprocessable("Monitor target applies only to kind ci or pr_mergeable");
    return monitor;
  }
  if (!target) throw unprocessable(`A ${monitor.kind} wait needs target.repo`);
  if (monitor.kind === "ci") {
    if (!target.sha) throw unprocessable("A ci wait needs the exact pushed head in target.sha");
    if (target.workflowRunId != null && (!Number.isSafeInteger(target.workflowRunId) || target.workflowRunId <= 0)) {
      throw unprocessable("target.workflowRunId must be a positive safe integer");
    }
    return { ...monitor, target: { ...target, pushedAt: target.pushedAt ?? now.toISOString() } };
  }
  if (target.workflowRunId != null) throw unprocessable("target.workflowRunId applies only to kind ci");
  if (!target.pullNumber) throw unprocessable("A pr_mergeable wait needs target.pullNumber");
  if (monitor.timeoutAt) return monitor;
  const deadline = new Date(Math.max(now.getTime(), Date.parse(monitor.nextCheckAt)) + PR_MERGEABLE_DEFAULT_DEADLINE_MS);
  return { ...monitor, timeoutAt: deadline.toISOString() };
}

export interface GitHubCheckRunReading {
  name: string;
  status: string;
  conclusion: string | null;
  checkSuiteId: number | null;
}

export interface GitHubWorkflowRunReading {
  id: number;
  workflowId?: number | null;
  name: string;
  status: string;
  conclusion: string | null;
  checkSuiteId: number | null;
  createdAt: string | null;
  headSha?: string | null;
}

export interface GitHubPullRequestReading {
  state: string;
  merged: boolean;
  mergeable: boolean | null;
  mergeableState: string | null;
  headSha: string | null;
}

export interface GitHubWaitSnapshot {
  checkRuns: GitHubCheckRunReading[];
  /** False when GitHub reported more check runs than one page holds. */
  checkRunsComplete: boolean;
  workflowRuns: GitHubWorkflowRunReading[];
  pullRequest: GitHubPullRequestReading | null;
}

export type WaitEvaluation =
  /** Keep waiting quietly; re-read at nextCheckAt. `notice` is a one-time report. */
  | { action: "keep_waiting"; observation: IssueWaitObservation; nextCheckAt: Date; notice: boolean }
  /** The wait resolved or needs the owner now. */
  | { action: "wake"; observation: IssueWaitObservation }
  /** The deadline passed unresolved: apply the record's recoveryPolicy. */
  | { action: "expire"; observation: IssueWaitObservation }
  /** GitHub could not be read: fall back to an ordinary owner wake. */
  | { action: "fallback"; observation: IssueWaitObservation };

function observation(state: IssueWaitObservationState, now: Date, detail: string): IssueWaitObservation {
  return { state, checkedAt: now.toISOString(), detail: detail.slice(0, 500) };
}

function shortSha(sha: string | null | undefined) {
  return sha ? sha.slice(0, 12) : "unknown";
}

function minutes(ms: number) {
  return Math.max(0, Math.round(ms / 60_000));
}

function readMs(value: string | null | undefined) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

// A completed run whose jobs were all skipped (e.g. a `pull_request: labeled` run whose
// `if:` excluded every job) executed no CI, so it must not supersede real evidence.
function skippedOnly(run: GitHubWorkflowRunReading, checkRuns: GitHubCheckRunReading[]) {
  if (run.status !== "completed") return false;
  if (run.conclusion === "skipped") return true;
  if (run.checkSuiteId === null) return false;
  const jobs = checkRuns.filter(job => job.checkSuiteId === run.checkSuiteId);
  return jobs.length > 0 && jobs.every(job => job.conclusion === "skipped");
}

function latestWorkflowRuns(runs: GitHubWorkflowRunReading[], checkRuns: GitHubCheckRunReading[]) {
  const latest = new Map<string, GitHubWorkflowRunReading>();
  for (const run of runs) {
    const key = run.workflowId == null ? `run:${run.id}` : `workflow:${run.workflowId}`;
    const previous = latest.get(key);
    const skipped = skippedOnly(run, checkRuns);
    const previousSkipped = previous ? skippedOnly(previous, checkRuns) : false;
    const time = readMs(run.createdAt);
    const previousTime = readMs(previous?.createdAt);
    const newer = previous && (time !== null && previousTime !== null && time !== previousTime
      ? time > previousTime : run.id > previous.id);
    if (!previous || (skipped === previousSkipped ? newer : previousSkipped)) latest.set(key, run);
  }
  return [...latest.values()];
}

function pullRequestGate(
  target: IssueWaitTarget,
  pr: GitHubPullRequestReading | null,
  now: Date,
): IssueWaitObservation | null {
  if (!pr) return null;
  const label = `${target.repo}#${target.pullNumber}`;
  if (pr.merged) return observation("closed", now, `${label} is merged.`);
  if (pr.state !== "open") return observation("closed", now, `${label} is ${pr.state}.`);
  if (target.sha && pr.headSha && pr.headSha.toLowerCase() !== target.sha.toLowerCase()) {
    return observation("superseded", now,
      `${label} head moved from ${shortSha(target.sha)} to ${shortSha(pr.headSha)}; record a wait for the new head.`);
  }
  if (pr.mergeableState === "dirty") {
    return observation("base_update_required", now,
      `${label} conflicts with its base (mergeable_state dirty). Merge the base branch and push before classifying CI; GitHub does not run PR CI on a conflicting head.`);
  }
  return null;
}

/** Pure classification of a `ci` wait from one GitHub reading. */
export function classifyCiWait(input: {
  target: IssueWaitTarget;
  snapshot: GitHubWaitSnapshot;
  now: Date;
  timeoutAt?: string | null;
  previous?: IssueWaitObservation | null;
}): WaitEvaluation {
  const { target, snapshot, now } = input;
  const nowMs = now.getTime();
  const sha = shortSha(target.sha);

  const gate = pullRequestGate(target, snapshot.pullRequest, now);
  if (gate) return { action: "wake", observation: gate };

  if (target.workflowRunId != null) {
    const run = snapshot.workflowRuns[0];
    if (snapshot.workflowRuns.length !== 1 || run?.id !== target.workflowRunId || !run.headSha) {
      return { action: "fallback", observation: observation("unobservable", now,
        `Workflow run ${target.workflowRunId} could not be identified. Keep the candidate pending; do not dispatch a duplicate.`) };
    }
    if (run.headSha.toLowerCase() !== target.sha?.toLowerCase()) {
      return { action: "wake", observation: observation("superseded", now,
        `Workflow run ${run.id} belongs to ${shortSha(run.headSha)}, not ${sha}. It cannot prove this candidate; inspect the current head before dispatching.`) };
    }
    if (!snapshot.checkRunsComplete || run.checkSuiteId === null ||
      snapshot.checkRuns.some(job => job.checkSuiteId !== run.checkSuiteId)) {
      return { action: "fallback", observation: observation("unobservable", now,
        `The complete jobs for workflow run ${run.id} could not be verified. Keep the candidate pending; inspect the existing run instead of dispatching again.`) };
    }
    if (run.status === "completed" && snapshot.checkRuns.length === 0) {
      return { action: "wake", observation: observation("startup_failure", now,
        `Workflow run ${run.id} on ${sha} completed with zero jobs. It is not candidate proof; fix the workflow before an explicit retry.`) };
    }
    if (run.status === "completed") {
      const allSucceeded = run.conclusion === "success" &&
        snapshot.checkRuns.every(job => job.status === "completed" && job.conclusion === "success");
      return { action: "wake", observation: observation(allSucceeded ? "passed" : "failed", now,
        allSucceeded
          ? `Workflow run ${run.id} at ${sha} succeeded with ${snapshot.checkRuns.length} successful jobs. Recheck the merge gate before merging.`
          : `Workflow run ${run.id} at ${sha} did not succeed in every job. Keep the candidate blocked and investigate; do not automatically retry.`) };
    }
  }

  const workflowRuns = latestWorkflowRuns(snapshot.workflowRuns, snapshot.checkRuns);
  const currentSuites = new Set(workflowRuns.map(run => run.checkSuiteId));
  const supersededSuites = new Set(snapshot.workflowRuns
    .filter(run => !workflowRuns.includes(run) && run.checkSuiteId !== null && !currentSuites.has(run.checkSuiteId))
    .map(run => run.checkSuiteId));
  const checkRuns = snapshot.checkRuns.filter(run => !supersededSuites.has(run.checkSuiteId));

  const suitesWithJobs = new Set(checkRuns.map(run => run.checkSuiteId).filter((id): id is number => id !== null));
  const startupFailure = workflowRuns.find(run =>
    run.conclusion === "startup_failure" || run.conclusion === "action_required" || run.status === "action_required" ||
    (snapshot.checkRunsComplete && run.status === "completed" && run.checkSuiteId !== null && !suitesWithJobs.has(run.checkSuiteId)));
  if (startupFailure) {
    const reason = startupFailure.conclusion === "startup_failure" ? "startup_failure"
      : startupFailure.conclusion === "action_required" || startupFailure.status === "action_required" ? "action_required"
      : "a workflow run with zero jobs";
    return { action: "wake", observation: observation("startup_failure", now,
      `Workflow "${startupFailure.name}" on ${sha} reported ${reason}. Fix the workflow or its approval; waiting cannot resolve it.`) };
  }

  const terminalFailure = workflowRuns.find(run =>
    run.status === "completed" && run.conclusion && FAILED_CONCLUSIONS.has(run.conclusion));
  if (terminalFailure) {
    const names = [terminalFailure.name, ...checkRuns
      .filter(run => run.conclusion && FAILED_CONCLUSIONS.has(run.conclusion))
      .map(run => run.name)].slice(0, 5).join(", ");
    return { action: "wake", observation: observation("failed", now,
      `CI for ${sha} finished with failures: ${names}. The completed workflow cannot keep waiting on queued child jobs.`) };
  }

  const activeChecks = checkRuns.filter(run => run.status !== "completed");
  const activeWorkflows = workflowRuns.filter(run => ACTIVE_WORKFLOW_STATUSES.has(run.status));
  if (activeChecks.length > 0 || activeWorkflows.length > 0) {
    const inProgress = activeChecks.some(run => run.status === "in_progress") ||
      activeWorkflows.some(run => run.status === "in_progress");
    // Queued time runs from when the workflow run was created; the push time
    // is only a fallback for check runs GitHub reports without a workflow run.
    const queuedAt = activeWorkflows.map(run => readMs(run.createdAt)).filter((ms): ms is number => ms !== null);
    const queuedSinceMs = queuedAt.length > 0 ? Math.min(...queuedAt) : readMs(target.pushedAt) ?? nowMs;
    const nextCheckAt = new Date(nowMs + CI_WAIT_POLL_MS);
    const count = `${activeChecks.length + activeWorkflows.length} active`;
    if (!inProgress && nowMs - queuedSinceMs >= CI_QUEUED_REPORT_MS) {
      return {
        action: "keep_waiting", nextCheckAt,
        notice: input.previous?.state !== "queued_long",
        observation: observation("queued_long", now,
          `CI for ${sha} has been queued ${minutes(nowMs - queuedSinceMs)} min with nothing in progress (runner wait). It has started; Paperclip keeps waiting and does not re-trigger.`),
      };
    }
    return { action: "keep_waiting", nextCheckAt, notice: false,
      observation: observation("started", now, `CI for ${sha} is ${inProgress ? "running" : "queued"} (${count}); waiting for it to finish.`) };
  }

  const completedRuns = checkRuns.length + workflowRuns.length;
  if (completedRuns > 0) {
    const failedChecks = checkRuns.filter(run => run.conclusion && FAILED_CONCLUSIONS.has(run.conclusion));
    const failedWorkflows = workflowRuns.filter(run => run.conclusion && FAILED_CONCLUSIONS.has(run.conclusion));
    if (failedChecks.length > 0 || failedWorkflows.length > 0) {
      const names = [...failedChecks, ...failedWorkflows].map(run => run.name).slice(0, 5).join(", ");
      return { action: "wake", observation: observation("failed", now, `CI for ${sha} finished with failures: ${names}.`) };
    }
    return { action: "wake", observation: observation("passed", now,
      `CI for ${sha} finished green (${checkRuns.length} check runs, ${workflowRuns.length} workflow runs).`) };
  }

  const pushedAtMs = readMs(target.pushedAt) ?? nowMs;
  const deadlineMs = readMs(input.timeoutAt) ?? pushedAtMs + CI_NO_START_DEADLINE_MS;
  if (nowMs < deadlineMs) {
    return { action: "keep_waiting", notice: false, nextCheckAt: new Date(Math.min(nowMs + CI_WAIT_POLL_MS, deadlineMs)),
      observation: observation("not_started", now, `No check run or workflow run exists yet for ${sha}; waiting for CI to start.`) };
  }
  return { action: "expire", observation: observation("no_start", now,
    `No check run or workflow run exists for ${sha} ${minutes(nowMs - pushedAtMs)} min after push${snapshot.pullRequest ? " and the PR has no conflict" : ""}. If an always-run workflow applies, re-trigger once (workflow dispatch or an empty commit); if no workflow covers the changed paths, record "no CI applies" with the reason.`) };
}

/** Pure classification of a `pr_mergeable` wait from one GitHub reading. */
export function classifyPullRequestMergeableWait(input: {
  target: IssueWaitTarget;
  snapshot: GitHubWaitSnapshot;
  now: Date;
  timeoutAt?: string | null;
}): WaitEvaluation {
  const { target, now } = input;
  const label = `${target.repo}#${target.pullNumber}`;
  const pr = input.snapshot.pullRequest;
  if (!pr) return { action: "fallback", observation: observation("unobservable", now, `${label} could not be read.`) };
  if (pr.merged || pr.state !== "open") {
    return { action: "wake", observation: observation("closed", now, `${label} is ${pr.merged ? "merged" : pr.state}.`) };
  }
  if (pr.mergeable === true) {
    return { action: "wake", observation: observation("mergeable", now, `${label} has no conflicts (mergeable_state ${pr.mergeableState ?? "unknown"}).`) };
  }
  const state: IssueWaitObservationState = pr.mergeableState === "dirty" || pr.mergeable === false ? "conflicting" : "pending_mergeability";
  const detail = state === "conflicting" ? `${label} conflicts with its base.` : `GitHub is still computing mergeability for ${label}.`;
  const deadlineMs = readMs(input.timeoutAt);
  if (deadlineMs !== null && now.getTime() >= deadlineMs) {
    return { action: "expire", observation: observation(state, now, `${detail} The wait deadline passed.`) };
  }
  const nextMs = now.getTime() + PR_MERGEABLE_WAIT_POLL_MS;
  return { action: "keep_waiting", notice: false, observation: observation(state, now, detail),
    nextCheckAt: new Date(deadlineMs === null ? nextMs : Math.min(nextMs, deadlineMs)) };
}

export function classifyServerWait(input: {
  monitor: Pick<IssueExecutionMonitorPolicy, "kind" | "target" | "timeoutAt">;
  snapshot: GitHubWaitSnapshot;
  now: Date;
  previous?: IssueWaitObservation | null;
}): WaitEvaluation {
  const target = input.monitor.target!;
  return input.monitor.kind === "ci"
    ? classifyCiWait({ target, snapshot: input.snapshot, now: input.now, timeoutAt: input.monitor.timeoutAt, previous: input.previous })
    : classifyPullRequestMergeableWait({ target, snapshot: input.snapshot, now: input.now, timeoutAt: input.monitor.timeoutAt });
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Read the exact GitHub state a wait record names, through the server's existing GitHub access. */
export async function readGitHubWaitSnapshot(input: {
  kind: (typeof SERVER_EVALUATED_WAIT_KINDS)[number];
  target: IssueWaitTarget;
  token: string;
  fetchImpl?: FetchLike;
}): Promise<GitHubWaitSnapshot> {
  const fetchImpl = input.fetchImpl ?? ghFetch;
  const repo = input.target.repo;
  const github = async (path: string) => {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.token}`,
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!response.ok) throw Object.assign(new Error(`GitHub ${response.status} for ${path}`), { status: response.status });
    return asRecord(await response.json());
  };

  let pullRequest: GitHubPullRequestReading | null = null;
  if (input.target.pullNumber) {
    const pr = await github(`/pulls/${input.target.pullNumber}`);
    pullRequest = {
      state: readString(pr?.state) ?? "unknown",
      merged: pr?.merged === true || Boolean(readString(pr?.merged_at)),
      mergeable: typeof pr?.mergeable === "boolean" ? pr.mergeable : null,
      mergeableState: readString(pr?.mergeable_state),
      headSha: readString(asRecord(pr?.head)?.sha),
    };
  }
  if (input.kind === "pr_mergeable" || !input.target.sha) {
    return { checkRuns: [], checkRunsComplete: true, workflowRuns: [], pullRequest };
  }

  if (input.target.workflowRunId != null) {
    const run = await github(`/actions/runs/${input.target.workflowRunId}`);
    const workflow: GitHubWorkflowRunReading = {
      id: readNumber(run?.id) ?? 0,
      workflowId: readNumber(run?.workflow_id),
      name: readString(run?.name) ?? "workflow",
      status: readString(run?.status) ?? "queued",
      conclusion: readString(run?.conclusion),
      checkSuiteId: readNumber(run?.check_suite_id),
      createdAt: readString(run?.created_at),
      headSha: readString(run?.head_sha),
    };
    if (workflow.id !== input.target.workflowRunId || workflow.headSha?.toLowerCase() !== input.target.sha.toLowerCase()) {
      return { checkRuns: [], checkRunsComplete: false, workflowRuns: [workflow], pullRequest };
    }
    const checkRuns: GitHubCheckRunReading[] = [];
    let complete = false;
    for (let page = 1; page <= MAX_WORKFLOW_JOB_PAGES; page++) {
      const jobs = await github(`/actions/runs/${workflow.id}/jobs?filter=latest&per_page=${GITHUB_PAGE_SIZE}&page=${page}`);
      const rows = Array.isArray(jobs?.jobs) ? jobs.jobs : [];
      for (const raw of rows) {
        const job = asRecord(raw);
        if (readNumber(job?.run_id) !== workflow.id || readString(job?.head_sha)?.toLowerCase() !== input.target.sha.toLowerCase()) {
          throw new Error(`GitHub returned a job outside workflow run ${workflow.id} at the target SHA`);
        }
        checkRuns.push({ name: readString(job?.name) ?? "job", status: readString(job?.status) ?? "queued",
          conclusion: readString(job?.conclusion), checkSuiteId: workflow.checkSuiteId });
      }
      const total = readNumber(jobs?.total_count);
      if (total !== null && checkRuns.length >= total) { complete = true; break; }
      if (rows.length < GITHUB_PAGE_SIZE) { complete = total === null; break; }
    }
    return { checkRuns, checkRunsComplete: complete, workflowRuns: [workflow], pullRequest };
  }

  const sha = encodeURIComponent(input.target.sha);
  const [checks, workflows] = await Promise.all([
    github(`/commits/${sha}/check-runs?per_page=${GITHUB_PAGE_SIZE}`),
    github(`/actions/runs?head_sha=${sha}&per_page=${GITHUB_PAGE_SIZE}`),
  ]);
  const rawChecks = Array.isArray(checks?.check_runs) ? checks.check_runs : [];
  const checkRuns = rawChecks.map((raw): GitHubCheckRunReading => {
    const run = asRecord(raw);
    return {
      name: readString(run?.name) ?? "check",
      status: readString(run?.status) ?? "queued",
      conclusion: readString(run?.conclusion),
      checkSuiteId: readNumber(asRecord(run?.check_suite)?.id),
    };
  });
  const rawWorkflows = Array.isArray(workflows?.workflow_runs) ? workflows.workflow_runs : [];
  const workflowRuns = rawWorkflows.map((raw): GitHubWorkflowRunReading => {
    const run = asRecord(raw);
    return {
      id: readNumber(run?.id) ?? 0,
      workflowId: readNumber(run?.workflow_id),
      name: readString(run?.name) ?? "workflow",
      status: readString(run?.status) ?? "queued",
      conclusion: readString(run?.conclusion),
      checkSuiteId: readNumber(run?.check_suite_id),
      createdAt: readString(run?.created_at),
    };
  });
  const totalChecks = readNumber(checks?.total_count) ?? checkRuns.length;
  return { checkRuns, checkRunsComplete: totalChecks <= checkRuns.length, workflowRuns, pullRequest };
}

/**
 * Evaluate one due server-side wait. Credential or GitHub failures fall back
 * to an ordinary owner wake rather than extending the wait unseen.
 */
export async function evaluateServerWait(input: {
  monitor: Pick<IssueExecutionMonitorPolicy, "kind" | "target" | "timeoutAt">;
  now: Date;
  previous?: IssueWaitObservation | null;
  resolveToken: () => Promise<string | null>;
  fetchImpl?: FetchLike;
}): Promise<WaitEvaluation> {
  const { monitor, now } = input;
  if (!isServerEvaluatedWaitKind(monitor.kind) || !monitor.target) {
    return { action: "fallback", observation: observation("unobservable", now, "The wait record has no GitHub target.") };
  }
  const token = await input.resolveToken().catch(() => null);
  if (!token) {
    return { action: "fallback", observation: observation("unobservable", now,
      "Paperclip has no GitHub API credential for this company, so it cannot read the wait target; check it yourself.") };
  }
  try {
    const snapshot = await readGitHubWaitSnapshot({ kind: monitor.kind, target: monitor.target, token, fetchImpl: input.fetchImpl });
    return classifyServerWait({ monitor, snapshot, now, previous: input.previous });
  } catch (err) {
    const status = readNumber(asRecord(err)?.status);
    return { action: "fallback", observation: observation("unobservable", now,
      `GitHub could not be read for ${monitor.target.repo}${status ? ` (HTTP ${status})` : ""}; check the wait target yourself.`) };
  }
}

