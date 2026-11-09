/**
 * Protected-main merge gate (FAC-840 B), pure decisions.
 *
 * The private repositories run on a GitHub plan without branch protection,
 * so this gate is the enforced merge path. A pull request merges only when:
 *
 * 1. it is current with its base (GitHub reports it zero commits behind and
 *    not conflicting), so CI on its head is CI on the merged result;
 * 2. CI at that exact head finished green, and every check the change needs
 *    ran and passed. A skipped check counts only when the repository policy
 *    lists it as optional, or as path-scoped with every changed file known to
 *    be irrelevant to it. Windows scripts always need Windows evidence, an
 *    unknown path means the check must run, and CI where nothing passed is
 *    never green;
 * 3. an independent review covered the source, from a different model family
 *    than every recorded implementation run. A head that differs from the
 *    reviewed head only by a clean merge from base needs CI only; resolved
 *    conflict hunks need a focused recheck at the new head; new source needs
 *    a review at the new head;
 * 4. the repository merge bar holds: 0 P0 and 0 P1, and every P2 is tracked;
 * 5. main is green. A red main stops every merge except the fix owned by the
 *    single red-main issue.
 */

export interface RepositoryMergePolicy {
  /** Suites that run on every pull request: each must have a passing check run. */
  alwaysRequiredChecks: Array<{ label: string; pattern: RegExp }>;
  /**
   * Checks a CI path filter may skip. Each may be skipped (or absent) only
   * when every changed file matches one of its `irrelevantPaths`.
   */
  pathScopedChecks: Array<{ platform: string; checks: string[]; irrelevantPaths: RegExp[] }>;
  /** Check runs that may skip on any change (selectors, not suites). Any other skip refuses. */
  optionalSkips: RegExp[];
  mergeMethod: "merge" | "squash" | "rebase";
}

/** Paths a Windows test suite executes in any repository (FAC-840 B, STA-163). */
export const WINDOWS_EXECUTED_PATHS: readonly RegExp[] = [
  /\.(ps1|psm1|psd1|cmd|bat)$/i,
  /^\.github\/scripts\//,
];

const WINDOWS_CHECK_NAME = /windows/i;

/**
 * Known policies. facette's `changes` job skips windows-fast/windows-native
 * for paths it does not list, including paths it has never seen. Here the
 * direction is reversed: only these paths are known not to affect a Windows
 * job; everything else needs Windows evidence.
 */
const FACETTE_WINDOWS_IRRELEVANT: RegExp[] = [
  /^account-web\//,
  /^docs\//,
  /^infra\//,
  /^[^/]+\.md$/,
];

const exactly = (name: string) => ({ label: name, pattern: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) });

export const REPOSITORY_MERGE_POLICIES: Record<string, RepositoryMergePolicy> = {
  // .github/workflows/ci.yml: these five jobs are unconditional; only the
  // Windows jobs sit behind the `changes` path filter.
  "ethanmonlux/facette": {
    alwaysRequiredChecks: ["changes", "shell", "agent", "account-web", "pr-status-block"].map(exactly),
    pathScopedChecks: [
      { platform: "windows", checks: ["windows-fast", "windows-native"], irrelevantPaths: FACETTE_WINDOWS_IRRELEVANT },
    ],
    optionalSkips: [],
    mergeMethod: "merge",
  },
  // .github/workflows/pr.yml (`ci / …` jobs). Sharded suites match by prefix;
  // a skipped shard still refuses through the skip rule.
  "ethanmonlux/paperclip": {
    alwaysRequiredChecks: [
      exactly("ci / policy"),
      { label: "ci / Typecheck + Release Registry", pattern: /^ci \/ Typecheck\b/ },
      exactly("ci / Build"),
      { label: "ci / General tests (server …)", pattern: /^ci \/ General tests \(server\b/ },
      { label: "ci / Verify serialized server suites", pattern: /^ci \/ Verify serialized server suites\b/ },
    ],
    pathScopedChecks: [],
    optionalSkips: [/^ci \/ Select Vitest files$/],
    mergeMethod: "merge",
  },
};

/** Unknown repositories: nothing may skip, and at least one check must pass. */
export const DEFAULT_REPOSITORY_MERGE_POLICY: RepositoryMergePolicy = {
  alwaysRequiredChecks: [], pathScopedChecks: [], optionalSkips: [], mergeMethod: "merge",
};

export function repositoryMergePolicy(repo: string): RepositoryMergePolicy {
  return REPOSITORY_MERGE_POLICIES[repo.toLowerCase()] ?? DEFAULT_REPOSITORY_MERGE_POLICY;
}

export interface MergeGateCheck {
  name: string;
  status: string;
  conclusion: string | null;
  kind: "check_run" | "workflow_run";
}

const PASSING_CONCLUSIONS = new Set(["success", "neutral"]);

export type MergeGateReasonCode =
  | "pull_request_not_open"
  | "head_moved"
  | "draft"
  | "base_update_required"
  | "mergeability_unknown"
  | "ci_absent"
  | "ci_pending"
  | "ci_failed"
  | "ci_incomplete"
  | "required_check_skipped"
  | "review_missing"
  | "review_not_independent"
  | "review_stale"
  | "conflict_recheck_required"
  | "merge_bar_failed"
  | "main_red"
  | "merge_in_progress";

export interface MergeGateReason {
  code: MergeGateReasonCode;
  detail: string;
}

function shortSha(sha: string | null | undefined) {
  return sha ? sha.slice(0, 12) : "unknown";
}

function matchesAny(path: string, patterns: readonly RegExp[]) {
  return patterns.some(pattern => pattern.test(path));
}

/**
 * Checks a change needs, by name. A path-scoped check is needed unless every
 * changed file is known to be irrelevant to it. An empty or unreadable file
 * list is unknown, so every path-scoped check is needed.
 */
export function requiredPathScopedChecks(input: {
  policy: RepositoryMergePolicy;
  changedFiles: readonly string[] | null;
}): string[] {
  const files = input.changedFiles;
  const required: string[] = [];
  for (const scope of input.policy.pathScopedChecks) {
    const allIrrelevant = files !== null && files.length > 0 && files.every(file =>
      matchesAny(file, scope.irrelevantPaths) && !(scope.platform === "windows" && matchesAny(file, WINDOWS_EXECUTED_PATHS)));
    if (!allIrrelevant) required.push(...scope.checks);
  }
  return required;
}

/**
 * CI at the exact head: green, complete, at least one check passed, every
 * suite the change needs passed, and nothing skipped that the policy does not
 * explicitly allow to skip for this change.
 */
export function evaluateHeadCi(input: {
  headSha: string;
  policy: RepositoryMergePolicy;
  checks: readonly MergeGateCheck[];
  checksComplete: boolean;
  /** Path-scoped checks this change needs (`requiredPathScopedChecks`). */
  requiredChecks: readonly string[];
  changedFiles: readonly string[] | null;
}): MergeGateReason[] {
  const sha = shortSha(input.headSha);
  if (!input.checksComplete) {
    return [{ code: "ci_incomplete", detail: `GitHub returned only part of the CI for ${sha}; the gate cannot prove it green.` }];
  }
  if (input.checks.length === 0) {
    return [{ code: "ci_absent", detail: `No check run or workflow run exists for ${sha}. Record a ci wait for this head; if CI never starts, re-trigger it once.` }];
  }
  const active = input.checks.filter(check => check.status !== "completed");
  if (active.length > 0) {
    return [{ code: "ci_pending", detail: `CI for ${sha} is still running (${active.length} active: ${active.map(check => check.name).slice(0, 5).join(", ")}). Record a ci wait and merge after it finishes.` }];
  }
  const failed = input.checks.filter(check => check.conclusion !== "skipped" && !PASSING_CONCLUSIONS.has(check.conclusion ?? ""));
  if (failed.length > 0) {
    return [{ code: "ci_failed", detail: `CI for ${sha} did not pass: ${failed.map(check => `${check.name} (${check.conclusion ?? "no conclusion"})`).slice(0, 5).join(", ")}.` }];
  }
  const checkRuns = input.checks.filter(check => check.kind === "check_run");
  const passed = checkRuns.filter(check => PASSING_CONCLUSIONS.has(check.conclusion ?? ""));
  if (passed.length === 0) {
    return [{ code: "ci_absent", detail: `No check run passed on ${sha}; skipped or empty CI is not evidence. CI must run and pass.` }];
  }
  const reasons: MergeGateReason[] = [];
  const reported = new Set<string>();
  for (const suite of input.policy.alwaysRequiredChecks) {
    if (passed.some(check => suite.pattern.test(check.name))) continue;
    for (const check of checkRuns) if (suite.pattern.test(check.name)) reported.add(check.name);
    reasons.push({ code: "required_check_skipped", detail: `${suite.label} runs on every change in this repository but did not pass on ${sha}. It must run and pass.` });
  }
  const ranGreen = new Set(passed.map(check => check.name));
  for (const name of input.requiredChecks) {
    if (ranGreen.has(name) || reported.has(name)) continue;
    reported.add(name);
    const skipped = checkRuns.some(check => check.name === name && check.conclusion === "skipped");
    reasons.push({ code: "required_check_skipped", detail: skipped
      ? `${name} was skipped by a CI path filter, but this change touches paths that check covers or paths not known to be irrelevant to it. It must run and pass on ${sha}.`
      : `${name} did not run on ${sha}, but this change needs it. It must run and pass.` });
  }
  // A skip is allowed only where the policy says so; a path filter that
  // skipped anything else, or a disabled suite, is not a green result.
  const skippablePathScoped = new Set(input.policy.pathScopedChecks.flatMap(scope => scope.checks)
    .filter(name => !input.requiredChecks.includes(name)));
  const touchesWindowsScripts = (input.changedFiles ?? []).some(file => matchesAny(file, WINDOWS_EXECUTED_PATHS));
  for (const check of checkRuns) {
    if (check.conclusion !== "skipped" || reported.has(check.name)) continue;
    if (skippablePathScoped.has(check.name) || matchesAny(check.name, input.policy.optionalSkips)) continue;
    reported.add(check.name);
    reasons.push({ code: "required_check_skipped", detail: touchesWindowsScripts && WINDOWS_CHECK_NAME.test(check.name)
      ? `${check.name} was skipped, but this change touches files a Windows suite executes. It must run and pass on ${sha}.`
      : `${check.name} was skipped on ${sha}, and this repository's merge policy does not list it as skippable for these paths. It must run and pass.` });
  }
  return reasons;
}

/** Conclusions on the base head that say nothing about whether the code works. */
const NON_VERDICT_CONCLUSIONS = new Set(["skipped", "cancelled", "stale"]);

/**
 * Red main: a finished check on the base head that failed. A cancelled or
 * superseded run is not a verdict on the code, so it does not make main red.
 */
export function evaluateBaseCi(input: { baseSha: string; checks: readonly MergeGateCheck[] }): { red: boolean; failing: string[] } {
  const failing = input.checks
    .filter(check => check.status === "completed" && !NON_VERDICT_CONCLUSIONS.has(check.conclusion ?? "") &&
      !PASSING_CONCLUSIONS.has(check.conclusion ?? ""))
    .map(check => check.name);
  return { red: failing.length > 0, failing: [...new Set(failing)] };
}

export interface MergeReviewAttestation {
  reviewIssueId: string;
  reviewIssueIdentifier: string | null;
  reviewIssueStatus: string;
  reviewerAgentId: string | null;
  /**
   * Model families recorded on the run that wrote the latest document
   * revision. Empty when that run recorded no model: not independent.
   */
  reviewerModelFamilies: string[];
  /** The document revision was written by the review issue's assignee. */
  writtenByReviewer: boolean;
  scope: "full" | "conflict_hunks";
  reviewedSha: string;
  pullRequest: string | null;
  p0: number;
  p1: number;
  p2: string[];
}

/** How the PR head relates to a reviewed head. */
export type HeadDelta =
  /** Same commit. */
  | { kind: "identical" }
  /** Only merges from base, and the PR's own diff is unchanged. CI only. */
  | { kind: "clean_base_update" }
  /** Only merges from base, but the PR's own diff changed: conflict hunks were resolved. */
  | { kind: "conflict_resolution"; files: string[] }
  /** New source commits, a rewritten history, or an unreadable delta. */
  | { kind: "source_changed"; detail: string };

/** Parse the `merge-review` document a reviewer writes on its review issue. */
export function parseMergeReviewDocument(body: string): Omit<MergeReviewAttestation,
  "reviewIssueId" | "reviewIssueIdentifier" | "reviewIssueStatus" | "reviewerAgentId" | "reviewerModelFamilies" | "writtenByReviewer"> | null {
  const field = (name: string) => {
    const match = new RegExp(`^\\s*[-*]?\\s*\`?${name}\`?\\s*:\\s*(.+?)\\s*$`, "im").exec(body);
    return match ? match[1]!.replace(/^`|`$/g, "").trim() : null;
  };
  const reviewedSha = field("reviewedSha")?.toLowerCase() ?? null;
  if (!reviewedSha || !/^[0-9a-f]{40}$/.test(reviewedSha)) return null;
  const count = (name: string) => {
    const value = field(name);
    return value !== null && /^\d+$/.test(value) ? Number(value) : null;
  };
  const p0 = count("p0");
  const p1 = count("p1");
  if (p0 === null || p1 === null) return null;
  const scopeValue = (field("scope") ?? "full").toLowerCase();
  const scope = scopeValue === "conflict_hunks" || scopeValue === "conflict-hunks" ? "conflict_hunks" : scopeValue === "full" ? "full" : null;
  if (!scope) return null;
  const p2Value = field("p2") ?? "none";
  const p2 = /^(none|0|-)$/i.test(p2Value) ? [] : p2Value.split(/[,\s]+/).filter(Boolean);
  return { scope, reviewedSha, pullRequest: field("pullRequest"), p0, p1, p2 };
}

const TRACKED_ISSUE = /^[A-Z][A-Z0-9]*-\d+$/;

function reviewLabel(review: MergeReviewAttestation) {
  return review.reviewIssueIdentifier ?? review.reviewIssueId;
}

/**
 * Model family from a recorded model id, falling back to a first-party
 * provider. Adapter names say nothing about the model (one adapter can run
 * several families), and an aggregator provider says nothing either.
 */
const MODEL_FAMILIES: Array<[RegExp, string]> = [
  [/claude|anthropic|\bopus\b|\bsonnet\b|\bhaiku\b|\bfable\b/i, "anthropic"],
  [/\bgpt|codex|openai|chatgpt|(^|[/:.\s])o[1-9](\b|-)/i, "openai"],
  [/gemini|gemma/i, "google"],
  [/grok|\bxai\b/i, "xai"],
  [/mistral|mixtral|codestral|devstral/i, "mistral"],
  [/deepseek/i, "deepseek"],
  [/qwen/i, "qwen"],
  [/llama/i, "meta"],
  [/kimi|moonshot/i, "moonshot"],
  [/\bglm\b|zhipu/i, "zhipu"],
];
const FIRST_PARTY_PROVIDERS = new Set(["anthropic", "openai", "google", "xai", "mistral", "deepseek"]);

export function modelFamily(input: { model?: string | null; provider?: string | null }): string | null {
  const model = input.model?.trim();
  if (model) {
    for (const [pattern, family] of MODEL_FAMILIES) if (pattern.test(model)) return family;
  }
  const provider = input.provider?.trim().toLowerCase();
  return provider && FIRST_PARTY_PROVIDERS.has(provider) ? provider : null;
}

/** Families a run recorded in its usage (`model`, `provider`, `usageByModel[].model`). */
export function modelFamiliesFromRunUsage(usage: unknown): string[] {
  const record = usage && typeof usage === "object" && !Array.isArray(usage) ? usage as Record<string, unknown> : null;
  if (!record) return [];
  const text = (value: unknown) => typeof value === "string" ? value : null;
  const families = new Set<string>();
  const provider = text(record.provider);
  const top = modelFamily({ model: text(record.model), provider });
  if (top) families.add(top);
  for (const entry of Array.isArray(record.usageByModel) ? record.usageByModel : []) {
    const model = entry && typeof entry === "object" ? text((entry as Record<string, unknown>).model) : null;
    const family = modelFamily({ model, provider: model ? null : provider });
    if (family) families.add(family);
  }
  return [...families].sort();
}

export interface MergeGateAuthor {
  agentId: string | null;
  /**
   * Model families that authored the change: every recorded implementation
   * run plus commit co-author trailers. Null when provenance is missing.
   */
  modelFamilies: string[] | null;
}

/** Independent: written by its assignee, done, another agent, and another model family. */
function independenceProblem(review: MergeReviewAttestation, author: MergeGateAuthor) {
  if (review.reviewIssueStatus !== "done") return `${reviewLabel(review)} is ${review.reviewIssueStatus}, not done.`;
  if (!review.writtenByReviewer || !review.reviewerAgentId) return `${reviewLabel(review)}'s merge-review document was not written by its assigned reviewer.`;
  if (author.agentId && review.reviewerAgentId === author.agentId) return `${reviewLabel(review)} was reviewed by the implementer.`;
  if (review.reviewerModelFamilies.length === 0) {
    return `The run that wrote ${reviewLabel(review)}'s merge-review document recorded no model, so the gate cannot show the review is cross-model.`;
  }
  if (!author.modelFamilies || author.modelFamilies.length === 0) {
    return `The gate found no recorded model for an implementation run of this task, so it cannot show ${reviewLabel(review)} is cross-model.`;
  }
  const shared = review.reviewerModelFamilies.filter(family => author.modelFamilies!.includes(family));
  if (shared.length > 0) {
    return `${reviewLabel(review)} used the implementer's model family (${shared.join(", ")}); the review must be cross-model.`;
  }
  return null;
}

/**
 * Review coverage and merge bar for the exact head. `deltaFor` reports how
 * the head relates to each reviewed head.
 */
export function evaluateReviewCoverage(input: {
  pullRequest: string;
  headSha: string;
  author: MergeGateAuthor;
  reviews: readonly MergeReviewAttestation[];
  deltaFor: (reviewedSha: string) => HeadDelta;
}): MergeGateReason[] {
  const sha = shortSha(input.headSha);
  const forThisPr = input.reviews.filter(review => !review.pullRequest ||
    review.pullRequest.toLowerCase() === input.pullRequest.toLowerCase());
  const full = forThisPr.filter(review => review.scope === "full");
  if (full.length === 0) {
    return [{ code: "review_missing", detail: `No independent review with a merge-review document (scope full) is linked for ${input.pullRequest}.` }];
  }
  const reasons: MergeGateReason[] = [];
  const independentFull = full.filter(review => {
    const problem = independenceProblem(review, input.author);
    if (problem) reasons.push({ code: "review_not_independent", detail: problem });
    return !problem;
  });
  if (independentFull.length === 0) return reasons;
  reasons.length = 0;

  // The newest covering full review decides; any covering review's findings count.
  let coverage: { review: MergeReviewAttestation; delta: HeadDelta } | null = null;
  for (const review of independentFull) {
    const delta = input.deltaFor(review.reviewedSha);
    if (delta.kind === "source_changed") continue;
    if (!coverage || delta.kind === "identical" ||
      (delta.kind === "clean_base_update" && coverage.delta.kind === "conflict_resolution")) coverage = { review, delta };
  }
  if (!coverage) {
    const latest = independentFull[independentFull.length - 1]!;
    const delta = input.deltaFor(latest.reviewedSha);
    return [{ code: "review_stale", detail: `The review covers ${shortSha(latest.reviewedSha)}, but the source changed before ${sha}${delta.kind === "source_changed" ? `: ${delta.detail}` : ""}. Review the new head.` }];
  }
  const covering = [coverage.review];
  if (coverage.delta.kind === "conflict_resolution") {
    const recheck = forThisPr.filter(review => review.scope === "conflict_hunks" &&
      review.reviewedSha === input.headSha.toLowerCase() && !independenceProblem(review, input.author));
    if (recheck.length === 0) {
      reasons.push({ code: "conflict_recheck_required", detail: `${sha} resolved conflicts after the review of ${shortSha(coverage.review.reviewedSha)} (files: ${coverage.delta.files.slice(0, 8).join(", ") || "unknown"}). A short independent cross-model check of only those conflict hunks at ${sha} is needed (merge-review scope conflict_hunks).` });
    } else {
      covering.push(...recheck);
    }
  }
  for (const review of covering) {
    if (review.p0 > 0 || review.p1 > 0) {
      reasons.push({ code: "merge_bar_failed", detail: `${reviewLabel(review)} reports ${review.p0} P0 and ${review.p1} P1; the merge bar is 0 of each.` });
    }
    const untracked = review.p2.filter(entry => !TRACKED_ISSUE.test(entry));
    if (untracked.length > 0) {
      reasons.push({ code: "merge_bar_failed", detail: `${reviewLabel(review)} lists P2s without a tracking issue (${untracked.slice(0, 5).join(", ")}); record each P2 as an issue and list its identifier.` });
    }
  }
  return reasons;
}

/** Normalize a unified diff so line-number shifts from base updates compare equal. */
export function normalizePatch(patch: string) {
  return patch.split("\n").map(line => line.startsWith("@@") ? "@@" : line).join("\n");
}

export interface PullRequestFileDiff {
  filename: string;
  status: string;
  /** Blob SHA of the file at the compared head. */
  blobSha: string | null;
  patch: string | null;
}

/**
 * Compare the PR's own diff at the reviewed head with its own diff at the
 * current head. Identical content, or identical hunks, means the base update
 * was clean. Anything else is a resolved conflict.
 */
export function classifyOwnDiffChange(reviewed: readonly PullRequestFileDiff[], current: readonly PullRequestFileDiff[]):
  { clean: true } | { clean: false; files: string[] } {
  const before = new Map(reviewed.map(file => [file.filename, file]));
  const changed = new Set<string>();
  for (const file of current) {
    const prior = before.get(file.filename);
    before.delete(file.filename);
    if (!prior || prior.status !== file.status) {
      changed.add(file.filename);
      continue;
    }
    if (prior.blobSha && file.blobSha && prior.blobSha === file.blobSha) continue;
    if (prior.patch === null || file.patch === null || normalizePatch(prior.patch) !== normalizePatch(file.patch)) changed.add(file.filename);
  }
  for (const name of before.keys()) changed.add(name);
  return changed.size === 0 ? { clean: true } : { clean: false, files: [...changed].sort() };
}

/** Commits between a reviewed head and the current head, from the PR side only. */
export function classifyHeadCommits(input: {
  reviewedSha: string;
  headSha: string;
  /** compare(reviewedSha...headSha): "ahead" or "identical" when reviewedSha is an ancestor. */
  status: string;
  complete: boolean;
  commits: ReadonlyArray<{ sha: string; parentCount: number }>;
  /** SHAs of commits that came from the base branch. */
  baseCommitShas: ReadonlySet<string>;
}): "identical" | "merges_from_base" | { sourceChanged: string } {
  if (input.reviewedSha.toLowerCase() === input.headSha.toLowerCase() || input.status === "identical") return "identical";
  if (input.status !== "ahead") return { sourceChanged: `the reviewed head is not an ancestor of the current head (compare status ${input.status}); history was rewritten` };
  if (!input.complete) return { sourceChanged: "too many commits since the review to classify" };
  const own = input.commits.filter(commit => !input.baseCommitShas.has(commit.sha));
  const authored = own.filter(commit => commit.parentCount < 2);
  if (authored.length > 0) return { sourceChanged: `${authored.length} new source commit(s) since the review (${authored.map(commit => shortSha(commit.sha)).slice(0, 3).join(", ")})` };
  return "merges_from_base";
}

export interface MergeGateDecision {
  mergeable: boolean;
  reasons: MergeGateReason[];
  requiredChecks: string[];
}

export function decideMerge(input: {
  pullRequest: { state: string; merged: boolean; draft: boolean; headSha: string; mergeable: boolean | null; mergeableState: string | null; behindBy: number | null };
  expectedHeadSha: string | null;
  ciReasons: readonly MergeGateReason[];
  reviewReasons: readonly MergeGateReason[];
  requiredChecks: readonly string[];
  redMain: { red: boolean; detail: string; exempt: boolean };
}): MergeGateDecision {
  const pr = input.pullRequest;
  const sha = shortSha(pr.headSha);
  const reasons: MergeGateReason[] = [];
  if (pr.merged || pr.state !== "open") {
    return { mergeable: false, requiredChecks: [...input.requiredChecks], reasons: [{ code: "pull_request_not_open", detail: `The pull request is ${pr.merged ? "already merged" : pr.state}.` }] };
  }
  if (input.expectedHeadSha && input.expectedHeadSha.toLowerCase() !== pr.headSha.toLowerCase()) {
    reasons.push({ code: "head_moved", detail: `The head moved from ${shortSha(input.expectedHeadSha)} to ${sha}; evaluate the new head.` });
  }
  if (pr.draft) reasons.push({ code: "draft", detail: "The pull request is a draft." });
  if (pr.mergeableState === "dirty" || pr.mergeable === false) {
    reasons.push({ code: "base_update_required", detail: `${sha} conflicts with its base. Merge the base branch, resolve the conflicts, push, and get CI plus a conflict-hunk check on the new head.` });
  } else if (pr.behindBy === null || pr.behindBy > 0) {
    reasons.push({ code: "base_update_required", detail: pr.behindBy === null
      ? `The gate could not prove ${sha} is current with its base.`
      : `${sha} is ${pr.behindBy} commit(s) behind its base. Merge the base branch, push, and let CI run on the new head (a clean update needs CI only).` });
  } else if (pr.mergeable === null) {
    reasons.push({ code: "mergeability_unknown", detail: "GitHub is still computing mergeability; try again shortly." });
  }
  if (input.redMain.red && !input.redMain.exempt) reasons.push({ code: "main_red", detail: input.redMain.detail });
  reasons.push(...input.ciReasons, ...input.reviewReasons);
  return { mergeable: reasons.length === 0, reasons, requiredChecks: [...input.requiredChecks] };
}
