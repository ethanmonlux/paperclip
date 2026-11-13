/**
 * Protected-main merge gate (FAC-840 B): the one merge path for agents.
 *
 * `evaluateAndMerge` reads the pull request, its base and CI through GitHub,
 * reads the linked review documents, decides with ./policy.ts, and merges
 * only at the exact head it verified. The whole check-and-merge holds one
 * lock per repository branch across server instances, and the base head is
 * read again under that lock just before merging, so a second merge cannot
 * land on a base its CI never ran against. A red main opens (or reuses) one
 * critical owner issue for that repository branch, assigned to an
 * urgent-capable agent, and parks the refused task on it with a blocker
 * relation, so the task resumes by itself when the fix lands. A change to a
 * repository's visual paths also needs, at the exact merge head, a candidate
 * run started after its code review and the designated visual reviewer's
 * passing verdict on that run, recorded after it finished (STA-362).
 */
import { forbidden, notFound, unprocessable } from "../../errors.js";
import { GitHubMergeGateError, type MergeGateGitHub } from "./github.js";
import {
  admittedCandidateRun,
  changedPaths,
  modelFamily,
  classifyHeadCommits,
  classifyOwnDiffChange,
  decideMerge,
  evaluateBaseCi,
  evaluateHeadCi,
  evaluateReviewCoverage,
  evaluateVisualReview,
  repositoryMergePolicy,
  requiredPathScopedChecks,
  reviewCoverage,
  requiresVisualReview,
  type HeadDelta,
  type MergeGateAuthor,
  type MergeGateReason,
  type MergeReviewAttestation,
  type VisualReviewAttestation,
} from "./policy.js";

export const MERGE_GATE_RED_MAIN_ORIGIN_KIND = "merge_gate_red_main";
export const MERGE_REVIEW_DOCUMENT_KEY = "merge-review";
export const VISUAL_REVIEW_DOCUMENT_KEY = "visual-review";
const MAX_ANCESTOR_DEPTH = 8;
export const MERGE_LOCK_BUSY = Symbol("merge-lock-busy");

/** Families named in commit `Co-Authored-By:` trailers (e.g. "Claude Opus 5.5 <noreply@anthropic.com>"). */
export function coAuthorModelFamilies(messages: ReadonlyArray<string | null | undefined>): string[] {
  const families = new Set<string>();
  for (const message of messages) {
    for (const match of (message ?? "").matchAll(/^\s*co-authored-by:\s*(.+)$/gim)) {
      const family = modelFamily({ model: match[1] });
      if (family) families.add(family);
    }
  }
  return [...families];
}

export interface MergeGateActor {
  type: "board" | "agent";
  agentId?: string | null;
  runId?: string | null;
  userId?: string | null;
}

export interface MergeGateRequest {
  companyId: string;
  /** The task that owns the pull request. */
  issueId: string;
  repo: string;
  pullNumber: number;
  expectedHeadSha?: string | null;
  reviewIssueIds?: string[];
  mergeMethod?: "merge" | "squash" | "rebase";
  dryRun?: boolean;
  actor: MergeGateActor;
}

export interface GateIssue {
  id: string;
  companyId: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  projectId: string | null;
  parentId: string | null;
  assigneeAgentId: string | null;
  createdByAgentId: string | null;
  originKind: string;
  originId: string | null;
}

export interface MergeGateResult {
  outcome: "merged" | "mergeable" | "refused" | "parked";
  repo: string;
  pullNumber: number;
  headSha: string | null;
  baseRef: string | null;
  mergeCommitSha?: string | null;
  requiredChecks: string[];
  reasons: MergeGateReason[];
  redMainIssue?: { id: string; identifier: string | null; created: boolean } | null;
}

export interface MergeGateDependencies {
  github: (repo: string, token: string) => MergeGateGitHub;
  resolveToken: (companyId: string, actor: MergeGateActor) => Promise<string | null>;
  loadIssue: (companyId: string, issueId: string) => Promise<GateIssue | null>;
  /** A recorded coordinator -> implementer -> coordinator handoff with an implementer run. */
  loadLegacyDelegation: (companyId: string, issueId: string, coordinatorAgentId: string) => Promise<boolean>;
  /** An implementer's accepted, agent-addressed review-routing handoff to its coordinator. */
  loadAcceptedCoordinatorRouting: (companyId: string, issueId: string, implementerAgentId: string, coordinatorAgentId: string) => Promise<boolean>;
  /**
   * Who may have authored the task: every agent with a run on it and the
   * model families those runs recorded. A creator or ancestor coordinator's
   * runs may be left out (`excludeAgentId`) only after its coordinator
   * authority is checked; a handoff coordinator's runs never are.
   * Reviewers are not: a reviewer with a run
   * on the task is a potential author. Null when the runs cannot be read, or
   * a potential author recorded no model.
   */
  loadTaskAuthorship: (companyId: string, input: {
    issueId: string; excludeAgentId: string | null; sourceAuthorAgentIds?: string[];
    /** The reviewer that attested `sourceAuthorAgentIds`; its own runs on the task always count. */
    attesterAgentId?: string;
  }) =>
    Promise<{ agentIds: string[]; modelFamilies: string[] } | null>;
  /**
   * Agents the task's own record ties to it as a possible implementer: its
   * creator, every agent ever assigned it or that checked it out, and its
   * current assignee. Read from the issue and its activity log, never from a
   * review document. Null when that history cannot be read.
   */
  loadTaskCustodians: (companyId: string, issueId: string) => Promise<string[] | null>;
  /**
   * Run `action` holding the merge lock for one repository branch, across
   * server instances. Returns `MERGE_LOCK_BUSY` when another merge holds it.
   */
  withMergeLock: <T>(key: string, action: () => Promise<T>) => Promise<T | typeof MERGE_LOCK_BUSY>;
  loadReviews: (companyId: string, input: { reviewIssueIds: string[]; repo: string; pullNumber: number }) => Promise<MergeReviewAttestation[]>;
  /** `visual-review` documents on the same review issues (or naming the pull request when none are given). */
  loadVisualReviews: (companyId: string, input: { reviewIssueIds: string[]; repo: string; pullNumber: number }) => Promise<VisualReviewAttestation[]>;
  /** Open (or return the open) red-main owner issue; at most one per repo branch. */
  ensureRedMainIssue: (input: {
    companyId: string; repo: string; baseRef: string; baseSha: string; failing: string[];
    fallbackAssigneeAgentId: string | null; projectId: string | null; evidence: string | null;
    actor: MergeGateActor; createIfMissing: boolean;
  }) => Promise<{ issue: GateIssue; created: boolean } | null>;
  parkOnIssue: (input: { companyId: string; issueId: string; blockerIssueId: string; actor: MergeGateActor }) => Promise<void>;
  log: (input: { companyId: string; issueId: string; actor: MergeGateActor; action: string; details: Record<string, unknown> }) => Promise<void>;
}

function normalizeRepo(repo: string) {
  const trimmed = repo.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) throw unprocessable("repo must be owner/name");
  return trimmed;
}

/**
 * How the merging actor is authorized. `handoff`: a legacy-return or
 * accepted-routing coordinator, whose task runs stay potential authorship.
 * `coordinator_with_task_runs`: a creator or ancestor coordinator that also
 * ran on the task; it may merge only when an independent exact-head review
 * attests source authors that exclude it.
 */
export type MergeAuthority = "board" | "coordinator" | "coordinator_with_task_runs" | "handoff";

/**
 * Coordinator-only: a board operator, or an agent that delegated the task
 * (its creator, an ancestor's assignee, or a recorded legacy handoff).
 */
export async function assertMayMerge(
  deps: Pick<MergeGateDependencies, "loadIssue" | "loadLegacyDelegation" | "loadAcceptedCoordinatorRouting" | "loadTaskAuthorship">,
  issue: GateIssue,
  actor: MergeGateActor,
): Promise<MergeAuthority> {
  if (actor.type === "board") return "board";
  const agentId = actor.agentId ?? null;
  if (!agentId) throw forbidden("The merge gate needs an authenticated board operator or coordinating agent");
  if (issue.assigneeAgentId === agentId) {
    if (await deps.loadLegacyDelegation(issue.companyId, issue.id, agentId)) return "handoff";
    throw forbidden("The implementer cannot merge its own task; the coordinator that delegated it merges through the gate");
  }
  // An engineer that created and still holds its task may route review to a
  // coordinator. That coordinator's runs stay potential authorship.
  if (issue.assigneeAgentId && issue.createdByAgentId === issue.assigneeAgentId &&
    await deps.loadAcceptedCoordinatorRouting(issue.companyId, issue.id, issue.assigneeAgentId, agentId)) return "handoff";
  let coordinatesTask = issue.createdByAgentId === agentId;
  if (!coordinatesTask) {
    let parentId = issue.parentId;
    for (let depth = 0; parentId && depth < MAX_ANCESTOR_DEPTH; depth++) {
      const parent = await deps.loadIssue(issue.companyId, parentId);
      if (!parent) break;
      if (parent.assigneeAgentId === agentId) {
        coordinatesTask = true;
        break;
      }
      parentId = parent.parentId;
    }
  }
  if (!coordinatesTask) {
    throw forbidden("Only the coordinator that delegated this task (its creator or an ancestor's assignee) can merge it");
  }
  // Either authority path can belong to a former implementer. Never exclude
  // the coordinator's task runs without first checking the full run history.
  // A coordinator that ran on the task (to route review, say) may still have
  // written source: no run records that it did not. It needs the review's
  // source-author attestation, checked at the merge head.
  const authorship = await deps.loadTaskAuthorship(issue.companyId, { issueId: issue.id, excludeAgentId: null });
  if (!authorship) throw forbidden("Task authorship could not be established; the merge gate cannot authorize this agent");
  return authorship.agentIds.includes(agentId) ? "coordinator_with_task_runs" : "coordinator";
}

async function isRedMainExempt(deps: Pick<MergeGateDependencies, "loadIssue">, issue: GateIssue, ownerIssueId: string) {
  let current: GateIssue | null = issue;
  for (let depth = 0; current && depth <= MAX_ANCESTOR_DEPTH; depth++) {
    if (current.id === ownerIssueId) return true;
    current = current.parentId ? await deps.loadIssue(issue.companyId, current.parentId) : null;
  }
  return false;
}

async function describeHeadDelta(github: MergeGateGitHub, input: {
  reviewedSha: string; headSha: string; baseSha: string; currentOwnDiff: Awaited<ReturnType<MergeGateGitHub["pullRequestFiles"]>>;
}): Promise<HeadDelta> {
  if (input.reviewedSha === input.headSha.toLowerCase()) return { kind: "identical" };
  try {
    const sinceReview = await github.compare(input.reviewedSha, input.headSha);
    const fromBase = await github.compare(input.reviewedSha, input.baseSha);
    const commits = classifyHeadCommits({
      reviewedSha: input.reviewedSha,
      headSha: input.headSha,
      status: sinceReview.status,
      complete: sinceReview.complete && fromBase.complete,
      commits: sinceReview.commits,
      baseCommitShas: new Set(fromBase.commits.map(commit => commit.sha)),
    });
    if (commits === "identical") return { kind: "identical" };
    if (typeof commits === "object") return { kind: "source_changed", detail: commits.sourceChanged };
    const reviewedOwnDiff = await github.compare(input.baseSha, input.reviewedSha);
    if (!reviewedOwnDiff.complete || !input.currentOwnDiff) {
      return { kind: "conflict_resolution", files: [] };
    }
    const change = classifyOwnDiffChange(reviewedOwnDiff.files, input.currentOwnDiff);
    return change.clean ? { kind: "clean_base_update" } : { kind: "conflict_resolution", files: change.files };
  } catch (err) {
    return { kind: "source_changed", detail: `the gate could not read the change since the review (${err instanceof Error ? err.message : "GitHub error"})` };
  }
}

export async function evaluateAndMerge(deps: MergeGateDependencies, request: MergeGateRequest): Promise<MergeGateResult> {
  const repo = normalizeRepo(request.repo);
  if (!Number.isSafeInteger(request.pullNumber) || request.pullNumber <= 0) throw unprocessable("pullNumber must be a positive integer");
  const issue = await deps.loadIssue(request.companyId, request.issueId);
  if (!issue) throw notFound("Issue not found");
  const authority = await assertMayMerge(deps, issue, request.actor);

  const token = await deps.resolveToken(request.companyId, request.actor);
  if (!token) throw unprocessable("No GitHub credential is available to the merge gate for this actor");
  const github = deps.github(repo, token);
  const policy = repositoryMergePolicy(repo);
  const label = `${repo}#${request.pullNumber}`;

  const readPullRequest = async () => {
    try {
      return await github.pullRequest(request.pullNumber);
    } catch (err) {
      throw unprocessable(err instanceof GitHubMergeGateError ? err.message : `Could not read ${label}`);
    }
  };
  const first = await readPullRequest();
  const context = { repo, label, policy, github, issue, authority };
  if (request.dryRun) return evaluateLocked(deps, request, context, first);
  // One check-and-merge at a time per repository branch, so two merges
  // cannot both pass against the same base and land one after the other.
  const lockKey = `merge-gate:${repo.toLowerCase()}:${first.baseRef}`;
  const result = await deps.withMergeLock(lockKey, async () => {
    const pr = await readPullRequest();
    if (pr.baseRef !== first.baseRef) {
      return { outcome: "refused" as const, repo, pullNumber: request.pullNumber, headSha: pr.headSha.toLowerCase(), baseRef: pr.baseRef,
        requiredChecks: [], redMainIssue: null,
        reasons: [{ code: "base_update_required" as const, detail: `The pull request's base changed from ${first.baseRef} to ${pr.baseRef} during the check. Try again.` }] };
    }
    return evaluateLocked(deps, request, context, pr);
  });
  if (result !== MERGE_LOCK_BUSY) return result;
  const reason: MergeGateReason = { code: "merge_in_progress", detail: `Another merge into ${repo} ${first.baseRef} is being checked or merged. Try again after it finishes; this head will then need to be current with the new base.` };
  return { outcome: "refused", repo, pullNumber: request.pullNumber, headSha: first.headSha.toLowerCase(), baseRef: first.baseRef,
    requiredChecks: [], reasons: [reason], redMainIssue: null };
}

async function evaluateLocked(
  deps: MergeGateDependencies,
  request: MergeGateRequest,
  context: { repo: string; label: string; policy: ReturnType<typeof repositoryMergePolicy>; github: MergeGateGitHub; issue: GateIssue; authority: MergeAuthority },
  pr: Awaited<ReturnType<MergeGateGitHub["pullRequest"]>>,
): Promise<MergeGateResult> {
  const { repo, label, policy, github, issue, authority } = context;
  const headSha = pr.headSha.toLowerCase();
  const baseSha = (await github.branchHead(pr.baseRef)).toLowerCase();
  // Everything below compares against this one base SHA, not the moving ref.
  const [ownDiff, compareToBase] = await Promise.all([
    github.pullRequestFiles(request.pullNumber).catch(() => null),
    github.compare(baseSha, headSha).catch(() => null),
  ]);
  const [headChecks, baseChecks] = await Promise.all([github.checks(headSha), github.checks(baseSha)]);

  const reviews = await deps.loadReviews(request.companyId, { reviewIssueIds: request.reviewIssueIds ?? [], repo, pullNumber: request.pullNumber });
  // A review written by the merging coordinator is not independent of the merge.
  const independentOfMerger = reviews.filter(review => !request.actor.agentId || review.reviewerAgentId !== request.actor.agentId);
  // Who may have authored the change is read from what the runs recorded,
  // not from the assignee's current adapter configuration. No run says
  // whether it wrote code, so every agent that ran on the task counts,
  // including one that reviews it now. A creator or ancestor coordinator
  // with no runs on the task is excluded; one that ran there (routing review,
  // say) merges only when the attestation below leaves it out. A handoff
  // coordinator (legacy return or accepted routing) may have authored code,
  // so its runs remain potential authorship.
  // A completed review can attest the exhaustive source author set, so
  // coordination and review runs on the task stop counting as authorship.
  // The attestation never narrows away its own reviewer: any started run the
  // reviewer has on the task still counts, so a reviewer that ran there is a
  // potential author and its review is not independent. Nothing recorded
  // shows that such a run wrote no source, and the reviewer's own list cannot
  // be that evidence. The reviewer must also never have been the task's
  // creator, assignee or checkout holder. The attested agents must still have
  // started runs on the task.
  const attestations = independentOfMerger.filter(review =>
    review.scope === "full" && review.reviewIssueStatus === "done" && review.writtenByReviewer &&
    review.reviewerAgentId && review.pullRequest?.toLowerCase() === label.toLowerCase() &&
    review.reviewedSha === headSha && review.sourceAuthorAgentIds?.length &&
    !review.sourceAuthorAgentIds.includes(review.reviewerAgentId));
  // Any exact-head attestation naming this coordinator as a source author
  // stands, whichever review the gate would otherwise rely on.
  const attestedAsAuthor = authority === "coordinator_with_task_runs" &&
    attestations.some(review => review.sourceAuthorAgentIds!.includes(request.actor.agentId!));
  const custodians = attestations.length > 0 && !attestedAsAuthor ? await deps.loadTaskCustodians(request.companyId, issue.id) : null;
  const trailerFamilies = compareToBase ? coAuthorModelFamilies(compareToBase.commits.map(commit => commit.message)) : [];
  const authorFrom = (authorship: Awaited<ReturnType<MergeGateDependencies["loadTaskAuthorship"]>>, attested: boolean): MergeGateAuthor => ({
    agentIds: authorship === null ? null
      : [...new Set([...authorship.agentIds, ...(!attested && issue.assigneeAgentId ? [issue.assigneeAgentId] : [])])].sort(),
    modelFamilies: authorship === null ? null : [...new Set([...authorship.modelFamilies, ...trailerFamilies])].sort(),
  });
  // The attesting review must itself pass at the exact head against the
  // authorship its list yields: independent, cross-model, with recorded
  // provenance, and within the merge bar. Otherwise another passing review
  // could launder an ineligible list. The newest qualifying attestation is used.
  let sourceReview: MergeReviewAttestation | undefined;
  let attestedAuthorship: Awaited<ReturnType<MergeGateDependencies["loadTaskAuthorship"]>> = null;
  let unqualified: string | null = null;
  for (const review of custodians ? [...attestations].reverse() : []) {
    if (custodians!.includes(review.reviewerAgentId!)) continue;
    const authorship = await deps.loadTaskAuthorship(request.companyId, {
      issueId: issue.id, excludeAgentId: null, sourceAuthorAgentIds: review.sourceAuthorAgentIds!, attesterAgentId: review.reviewerAgentId!,
    });
    const problems = evaluateReviewCoverage({ pullRequest: label, headSha, author: authorFrom(authorship, true), reviews: [review],
      deltaFor: () => ({ kind: "identical" }) });
    if (problems.length === 0) {
      sourceReview = review;
      attestedAuthorship = authorship;
      break;
    }
    unqualified ??= `${review.reviewIssueIdentifier ?? review.reviewIssueId} does not qualify: ${problems[0]!.detail}`;
  }
  const sourceAuthorAgentIds = sourceReview?.sourceAuthorAgentIds ?? undefined;
  // Checked before anything below can open a red-main issue for this actor.
  if (authority === "coordinator_with_task_runs" && (attestedAsAuthor || !sourceAuthorAgentIds)) {
    throw forbidden(attestedAsAuthor
      ? "The implementer cannot merge its own task; an exact-head review attests this agent as a source author"
      : `The implementer cannot merge its own task: this coordinator ran on the task, so it may merge only with a completed, passing, cross-model full review of ${headSha.slice(0, 12)} whose sourceAuthorAgentIds, written by a reviewer that never held or ran on the task, exclude it${unqualified ? ` (${unqualified})` : ""}`);
  }

  // Main stays green: CI red on the base head, or an open owner issue.
  const baseCi = evaluateBaseCi({ baseSha, checks: baseChecks.checks, policy });
  const owner = await deps.ensureRedMainIssue({
    companyId: request.companyId, repo, baseRef: pr.baseRef, baseSha, failing: baseCi.failing,
    fallbackAssigneeAgentId: issue.assigneeAgentId, projectId: issue.projectId, evidence: null,
    actor: request.actor, createIfMissing: baseCi.red && !request.dryRun,
  });
  const exempt = owner ? await isRedMainExempt(deps, issue, owner.issue.id) : false;
  const failingDetail = baseCi.failing.length ? ` (${baseCi.failing.slice(0, 5).join(", ")} on ${baseSha.slice(0, 12)})` : "";
  const redMain = {
    red: Boolean(owner) || baseCi.red,
    exempt,
    detail: owner
      ? `${pr.baseRef} is red${failingDetail}. ${owner.issue.identifier ?? owner.issue.id} owns the fix; merges wait until it is done.`
      : `${pr.baseRef} is red${failingDetail}. A merge would open its single owner issue and park this task on it.`,
  };

  // A rename counts on both sides: moving a file out of a scoped path changes that path.
  const changedFiles = changedPaths(ownDiff);
  const requiredChecks = requiredPathScopedChecks({ policy, changedFiles });
  const ciReasons = evaluateHeadCi({ headSha, policy, checks: headChecks.checks, checksComplete: headChecks.complete, requiredChecks, changedFiles });

  const authorship = sourceReview ? attestedAuthorship : await deps.loadTaskAuthorship(request.companyId, {
    issueId: issue.id,
    excludeAgentId: authority === "handoff" ? null : request.actor.agentId ?? null,
  });
  const author = authorFrom(authorship, Boolean(sourceReview));
  const deltas = new Map<string, HeadDelta>();
  for (const review of independentOfMerger) {
    if (!deltas.has(review.reviewedSha)) {
      deltas.set(review.reviewedSha, await describeHeadDelta(github, { reviewedSha: review.reviewedSha, headSha, baseSha, currentOwnDiff: ownDiff }));
    }
  }
  const coverage = reviewCoverage({
    pullRequest: label, headSha, author, reviews: independentOfMerger,
    deltaFor: sha => deltas.get(sha) ?? { kind: "source_changed", detail: "unread" },
  });
  const reviewReasons = coverage.reasons;

  // A visual change also needs, after its code review, a candidate run and a
  // visual verdict on that run's evidence, all at this head.
  const visualRequired = requiresVisualReview({ policy, changedFiles });
  const visualReviews = visualRequired
    ? (await deps.loadVisualReviews(request.companyId, { reviewIssueIds: request.reviewIssueIds ?? [], repo, pullNumber: request.pullNumber }))
      .filter(review => !request.actor.agentId || review.reviewerAgentId !== request.actor.agentId)
    : [];
  const visualReasons = evaluateVisualReview({
    pullRequest: label, headSha, required: visualRequired, author, reviews: visualReviews,
    candidate: visualRequired ? admittedCandidateRun({ policy, checks: headChecks.checks, headSha }) : null,
    codeReviews: coverage.reasons.length === 0 ? coverage.covering : [],
  });

  const decision = decideMerge({
    pullRequest: { ...pr, headSha, behindBy: compareToBase ? compareToBase.behindBy : null },
    expectedHeadSha: request.expectedHeadSha ?? null,
    ciReasons, reviewReasons, visualReasons, requiredChecks, redMain,
  });
  const base: Omit<MergeGateResult, "outcome"> = {
    repo, pullNumber: request.pullNumber, headSha, baseRef: pr.baseRef, requiredChecks: decision.requiredChecks, reasons: decision.reasons,
    redMainIssue: owner ? { id: owner.issue.id, identifier: owner.issue.identifier, created: owner.created } : null,
  };

  if (!decision.mergeable) {
    const parked = Boolean(owner && !exempt && !request.dryRun && decision.reasons.some(reason => reason.code === "main_red"));
    if (parked && owner) {
      await deps.parkOnIssue({ companyId: request.companyId, issueId: issue.id, blockerIssueId: owner.issue.id, actor: request.actor });
    }
    if (!request.dryRun) {
      await deps.log({ companyId: request.companyId, issueId: issue.id, actor: request.actor, action: "merge_gate.refused",
        details: { repo, pullNumber: request.pullNumber, headSha, reasons: decision.reasons, parkedOn: parked ? owner?.issue.id : null } });
    }
    return { outcome: parked ? "parked" : "refused", ...base };
  }
  if (request.dryRun) return { outcome: "mergeable", ...base };

  // The lock stops other gate merges; this catches a base that moved some
  // other way while the checks above ran.
  const baseNow = (await github.branchHead(pr.baseRef).catch(() => null))?.toLowerCase() ?? null;
  if (baseNow !== baseSha) {
    const reason: MergeGateReason = { code: "base_update_required", detail: baseNow
      ? `${pr.baseRef} moved from ${baseSha.slice(0, 12)} to ${baseNow.slice(0, 12)} while the gate was checking. Merge the base branch, push, and let CI run on the new head.`
      : `The gate could not re-read ${pr.baseRef} before merging, so it cannot prove ${headSha.slice(0, 12)} is current.` };
    await deps.log({ companyId: request.companyId, issueId: issue.id, actor: request.actor, action: "merge_gate.refused",
      details: { repo, pullNumber: request.pullNumber, headSha, reasons: [reason] } });
    return { outcome: "refused", ...base, reasons: [reason] };
  }

  let merged;
  try {
    merged = await github.merge(request.pullNumber, {
      sha: headSha,
      method: request.mergeMethod ?? policy.mergeMethod,
      title: `Merge pull request #${request.pullNumber}${pr.headRef ? ` from ${pr.headRef}` : ""}`,
    });
  } catch (err) {
    const reason: MergeGateReason = err instanceof GitHubMergeGateError && err.status === 409
      ? { code: "head_moved", detail: `GitHub refused the merge because the head moved after ${headSha.slice(0, 12)} was verified.` }
      : { code: "mergeability_unknown", detail: err instanceof Error ? err.message : "GitHub refused the merge." };
    await deps.log({ companyId: request.companyId, issueId: issue.id, actor: request.actor, action: "merge_gate.refused",
      details: { repo, pullNumber: request.pullNumber, headSha, reasons: [reason] } });
    return { outcome: "refused", ...base, reasons: [reason] };
  }
  await deps.log({ companyId: request.companyId, issueId: issue.id, actor: request.actor, action: "merge_gate.merged",
    details: { repo, pullNumber: request.pullNumber, headSha, baseRef: pr.baseRef, baseSha, mergeCommitSha: merged.sha, requiredChecks } });
  return { outcome: merged.merged ? "merged" : "refused", ...base, mergeCommitSha: merged.sha,
    reasons: merged.merged ? [] : [{ code: "mergeability_unknown", detail: merged.message || "GitHub did not merge." }] };
}

/** Declare main red from evidence the base head's CI cannot show (e.g. every PR fails the same suite). */
export async function reportRedMain(deps: MergeGateDependencies, input: {
  companyId: string; repo: string; baseRef: string; evidence: string; reportingIssueId: string | null; actor: MergeGateActor;
}) {
  const repo = normalizeRepo(input.repo);
  if (!input.evidence.trim()) throw unprocessable("evidence is required");
  const reporting = input.reportingIssueId ? await deps.loadIssue(input.companyId, input.reportingIssueId) : null;
  if (input.reportingIssueId && !reporting) throw notFound("Reporting issue not found");
  const owner = await deps.ensureRedMainIssue({
    companyId: input.companyId, repo, baseRef: input.baseRef, baseSha: "", failing: [],
    fallbackAssigneeAgentId: reporting?.assigneeAgentId ?? input.actor.agentId ?? null,
    projectId: reporting?.projectId ?? null, evidence: input.evidence.trim().slice(0, 4000),
    actor: input.actor, createIfMissing: true,
  });
  if (!owner) throw unprocessable("Could not open the red-main owner issue");
  if (reporting && reporting.id !== owner.issue.id && !(await isRedMainExempt(deps, reporting, owner.issue.id))) {
    await deps.parkOnIssue({ companyId: input.companyId, issueId: reporting.id, blockerIssueId: owner.issue.id, actor: input.actor });
  }
  return { issue: { id: owner.issue.id, identifier: owner.issue.identifier }, created: owner.created };
}

