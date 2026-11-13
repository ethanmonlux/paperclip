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
 *    single red-main issue;
 * 6. a change to what the user sees (a repository's visual paths, on either
 *    side of a rename) also has one finished candidate run at the exact merge
 *    head, started after its code review, and a passing verdict from the
 *    designated visual reviewer on that run's evidence, recorded after the
 *    run finished (STA-362).
 */

export interface RepositoryMergePolicy {
  /** Suites that run on every pull request: each must have a passing check run. */
  alwaysRequiredChecks: Array<{ label: string; pattern: RegExp }>;
  /**
   * Checks a CI path filter may skip or not start. With `irrelevantPaths`,
   * a check may be skipped (or absent) only when every changed file matches
   * one of them, so an unknown path needs the check. With `relevantPaths`
   * (a workflow-level `paths:` trigger), the check is needed when any changed
   * file matches one. Either way, a file a Windows suite executes always
   * needs a Windows check.
   */
  pathScopedChecks: Array<{
    platform: string;
    checks: string[];
    irrelevantPaths?: RegExp[];
    relevantPaths?: RegExp[];
    maintenanceOnlyPaths?: RegExp[];
    workflowPath?: string;
  }>;
  /**
   * Check runs that may skip on any change: selectors, and jobs that run
   * only on a label or manual dispatch. Any other skip refuses.
   */
  optionalSkips: RegExp[];
  /**
   * Jobs the repository's own CI plan may skip, each accepted as skipped only
   * when its `validator` check passed. The validator is an always-run job
   * that fails unless every planned suite has the result the plan chose
   * (success when selected, skipped when not).
   */
  planValidatedSkips: Array<{ validator: string; checks: RegExp[] }>;
  /**
   * Paths that change what the user sees. A change touching one, or with an
   * unknown file list, needs a passing `visual-review` verdict on the
   * `candidate` path scope's run at the exact merge head, in addition to its
   * code review.
   */
  visualPaths?: RegExp[];
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

/**
 * Facette paths that change what the user sees: the shell and agent UI,
 * Faces, Kaia/Rive art and the native app all live under these. Each needs
 * the Internal Windows candidate and a visual review at the merge head.
 */
const FACETTE_VISUAL_PATHS: RegExp[] = [/^shell\//, /^agent\//];

const exactly = (name: string) => ({ label: name, pattern: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) });

export const REPOSITORY_MERGE_POLICIES: Record<string, RepositoryMergePolicy> = {
  // .github/workflows/ci.yml: these five jobs are unconditional; only the
  // Windows jobs sit behind the `changes` path filter.
  "ethanmonlux/facette": {
    alwaysRequiredChecks: ["changes", "shell", "agent", "account-web", "pr-status-block"].map(exactly),
    pathScopedChecks: [
      { platform: "windows", checks: ["windows-fast", "windows-native"], irrelevantPaths: FACETTE_WINDOWS_IRRELEVANT },
      {
        platform: "candidate",
        checks: ["frontend", "candidate", "browser-evidence"],
        workflowPath: ".github/workflows/internal-windows.yml",
        relevantPaths: [...FACETTE_VISUAL_PATHS, /^\.github\/workflows\/internal-windows\.yml$/],
        maintenanceOnlyPaths: [
          /^\.github\/workflows\/internal-windows\.yml$/,
          /^\.github\/scripts\/detect-changed-paths\.sh$/,
          /^\.github\/scripts\/detect-changed-paths\.test\.sh$/,
          /^\.github\/scripts\/internal-windows-workflow\.test\.mjs$/,
        ],
      },
    ],
    optionalSkips: [],
    planValidatedSkips: [],
    visualPaths: FACETTE_VISUAL_PATHS,
    mergeMethod: "merge",
  },
  // .github/workflows/pr.yml calls pr-trusted.yml (`ci / …` jobs). Its PR
  // plan is change-scoped (STA-223, .github/staple-ci-scope.json): it may skip
  // any test suite, and the nightly staple-certify.yml run certifies the full
  // suite before an install. `ci / verify` is the stable aggregate: it always
  // runs and fails unless every planned suite, e2e included, has the result
  // the plan chose. `ci / e2e` does the same for the e2e shards. Only policy
  // runs on every change; the plan may skip typecheck, the affected-package
  // typecheck and build, and `ci / verify` asserts each passed when selected.
  "ethanmonlux/paperclip": {
    alwaysRequiredChecks: [
      exactly("ci / policy"),
      exactly("ci / verify"),
      exactly("ci / e2e"),
    ],
    // runner-windows.yml starts only for these paths (its `paths:` trigger).
    pathScopedChecks: [{
      platform: "windows",
      checks: ["Runner Rust (Windows x64)"],
      relevantPaths: [
        /^\.github\/workflows\/runner-windows\.yml$/,
        /^packages\/paperclip-runner\/(rust-toolchain\.toml|acpx-profiles\.json|antigravity-distributions\.json)$/,
        /^packages\/paperclip-runner\/(runner|protocol|test-fixtures|test\/fixtures)\//,
        /^tests\/runner-e2e\/fixtures\//,
      ],
    }],
    optionalSkips: [
      // The plan's test selector; skipped when no selection applies.
      /^ci \/ Select Vitest files$/,
      // storybook-visual.yml: visual tests need the `storybook-visual` label
      // or a manual dispatch, the preview deploy a manual `deploy_preview`.
      /^Storybook visual regression$/,
      /^Deploy selected branch Storybook$/,
      // ci-work-benchmark.yml starts for CI-file changes, but its jobs run
      // only with the `profile-ci` label.
      /^(paired|rust_prime|rust_restore)$/,
    ],
    planValidatedSkips: [
      {
        validator: "ci / verify",
        checks: [
          /^ci \/ Typecheck\b/,
          /^ci \/ Affected packages \(typecheck\)$/,
          /^ci \/ Build$/,
          /^ci \/ General tests \(/,
          /^ci \/ Verify serialized server suites\b/,
          /^ci \/ e2e shard \(/,
          /^ci \/ Verify Paperclip Runner \(/,
          /^ci \/ Docker context integrity$/,
          /^ci \/ Sandbox provider tests$/,
          /^ci \/ Canary Dry Run$/,
          /^ci \/ Runner support suite$/,
        ],
      },
      { validator: "ci / e2e", checks: [/^ci \/ e2e shard \(/] },
    ],
    mergeMethod: "merge",
  },
};

/** Unknown repositories: nothing may skip, and at least one check must pass. */
export const DEFAULT_REPOSITORY_MERGE_POLICY: RepositoryMergePolicy = {
  alwaysRequiredChecks: [], pathScopedChecks: [], optionalSkips: [], planValidatedSkips: [], mergeMethod: "merge",
};

export function repositoryMergePolicy(repo: string): RepositoryMergePolicy {
  return REPOSITORY_MERGE_POLICIES[repo.toLowerCase()] ?? DEFAULT_REPOSITORY_MERGE_POLICY;
}

export interface MergeGateCheck {
  name: string;
  status: string;
  conclusion: string | null;
  kind: "check_run" | "workflow_run";
  headSha?: string | null;
  checkSuiteId?: number | null;
  workflowPath?: string | null;
  runId?: number | null;
  runAttempt?: number | null;
  createdAt?: string | null;
  /** Check run `started_at`; workflow run `run_started_at` (the latest attempt's start). */
  startedAt?: string | null;
  /** Check run `completed_at`. */
  completedAt?: string | null;
  checkRunId?: number | null;
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
  | "visual_review_missing"
  | "visual_review_not_independent"
  | "visual_review_stale"
  | "visual_review_failed"
  | "visual_review_unbound"
  | "review_order_invalid"
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
 * changed file is known to be irrelevant to it (or, for a `relevantPaths`
 * scope, no changed file is relevant to it). A file a Windows suite executes
 * always needs the Windows checks. An empty or unreadable file list is
 * unknown, so every path-scoped check is needed.
 */
export function requiredPathScopedChecks(input: {
  policy: RepositoryMergePolicy;
  changedFiles: readonly string[] | null;
}): string[] {
  const files = input.changedFiles;
  const required: string[] = [];
  for (const scope of input.policy.pathScopedChecks) {
    if (files !== null && files.length > 0 && scope.maintenanceOnlyPaths &&
      files.every(file => matchesAny(file, scope.maintenanceOnlyPaths!))) continue;
    const irrelevant = (file: string) => {
      if (scope.platform === "windows" && matchesAny(file, WINDOWS_EXECUTED_PATHS)) return false;
      if (scope.relevantPaths) return !matchesAny(file, scope.relevantPaths);
      return matchesAny(file, scope.irrelevantPaths ?? []);
    };
    const allIrrelevant = files !== null && files.length > 0 && files.every(irrelevant);
    if (!allIrrelevant) required.push(...scope.checks);
  }
  return required;
}

function currentWorkflowChecks(input: {
  policy: RepositoryMergePolicy;
  checks: readonly MergeGateCheck[];
  headSha: string;
}): readonly MergeGateCheck[] {
  let checks = [...input.checks];
  for (const scope of input.policy.pathScopedChecks) {
    if (!scope.workflowPath) continue;
    const runs = checks.filter(check => check.kind === "workflow_run" && check.workflowPath === scope.workflowPath &&
      check.headSha?.toLowerCase() === input.headSha.toLowerCase() && check.runId != null && check.checkSuiteId != null);
    if (runs.length > 1 && runs.some(run => !Number.isFinite(Date.parse(run.createdAt ?? "")))) continue;
    const created = (run: MergeGateCheck) => Date.parse(run.createdAt ?? "") || 0;
    runs.sort((left, right) => created(right) - created(left) || right.runId! - left.runId! ||
      (right.runAttempt ?? 1) - (left.runAttempt ?? 1));
    const latest = runs[0];
    if (!latest) continue;
    const older = new Set(runs.slice(1));
    const olderSuites = new Set(runs.slice(1).map(run => run.checkSuiteId).filter(id => id !== latest.checkSuiteId));
    const latestJobs = new Map<string, MergeGateCheck>();
    for (const job of checks) {
      if (job.kind !== "check_run" || job.checkSuiteId !== latest.checkSuiteId || job.checkRunId == null) continue;
      const previous = latestJobs.get(job.name);
      if (!previous || job.checkRunId > previous.checkRunId!) latestJobs.set(job.name, job);
    }
    checks = checks.filter(check => {
      if (older.has(check)) return false;
      if (check.kind !== "check_run") return true;
      if (olderSuites.has(check.checkSuiteId)) return false;
      const latestJob = check.checkSuiteId === latest.checkSuiteId ? latestJobs.get(check.name) : undefined;
      return !latestJob || check === latestJob || check.checkRunId == null;
    });
  }
  return checks;
}

type PathScope = RepositoryMergePolicy["pathScopedChecks"][number];

/**
 * The one completed, successful `scope.workflowPath` run at the head whose
 * suite holds exactly one successful job per scope check, from checks already
 * narrowed to each workflow's latest run (`currentWorkflowChecks`).
 */
function provenWorkflowRun(input: { scope: PathScope; checks: readonly MergeGateCheck[]; headSha: string }) {
  const head = input.headSha.toLowerCase();
  const workflows = input.checks.filter(run => run.kind === "workflow_run" &&
    run.workflowPath === input.scope.workflowPath && run.headSha?.toLowerCase() === head);
  const run = workflows.length === 1 ? workflows[0]! : null;
  if (!run || run.status !== "completed" || run.conclusion !== "success" || run.runId == null || run.checkSuiteId == null) return null;
  const jobs: MergeGateCheck[] = [];
  for (const name of input.scope.checks) {
    const matching = input.checks.filter(check => check.kind === "check_run" && check.name === name && check.checkSuiteId === run.checkSuiteId);
    const job = matching.length === 1 ? matching[0]! : null;
    if (!job || job.headSha?.toLowerCase() !== head || job.status !== "completed" || job.conclusion !== "success") return null;
    jobs.push(job);
  }
  return { run, jobs };
}

/** The finished candidate run a visual verdict must judge. */
export interface AdmittedCandidateRun {
  workflowPath: string;
  runId: number;
  runAttempt: number;
  /** Earliest start of the attempt or any of its jobs; null when one is unrecorded. */
  startedAt: string | null;
  /** Latest job completion; null when one is unrecorded. */
  completedAt: string | null;
}

function parsedTime(value: string | null | undefined) {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? time : null;
}

/**
 * The `candidate` path scope's proven run at the exact head, or null when
 * the policy has none or no single finished, successful run exists there.
 */
export function admittedCandidateRun(input: {
  policy: RepositoryMergePolicy;
  checks: readonly MergeGateCheck[];
  headSha: string;
}): AdmittedCandidateRun | null {
  const scope = input.policy.pathScopedChecks.find(entry => entry.platform === "candidate" && entry.workflowPath);
  if (!scope) return null;
  const proven = provenWorkflowRun({ scope, checks: currentWorkflowChecks(input), headSha: input.headSha });
  if (!proven) return null;
  const starts = [proven.run.startedAt, ...proven.jobs.map(job => job.startedAt)].map(parsedTime);
  const ends = proven.jobs.map(job => parsedTime(job.completedAt));
  return {
    workflowPath: scope.workflowPath!,
    runId: proven.run.runId!,
    runAttempt: proven.run.runAttempt ?? 1,
    startedAt: starts.some(time => time === null) ? null : new Date(Math.min(...starts as number[])).toISOString(),
    completedAt: ends.some(time => time === null) ? null : new Date(Math.max(...ends as number[])).toISOString(),
  };
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
  const checks = currentWorkflowChecks(input);
  if (!input.checksComplete) {
    return [{ code: "ci_incomplete", detail: `GitHub returned only part of the CI for ${sha}; the gate cannot prove it green.` }];
  }
  if (checks.length === 0) {
    return [{ code: "ci_absent", detail: `No check run or workflow run exists for ${sha}. Record a ci wait for this head; if CI never starts, re-trigger it once.` }];
  }
  const active = checks.filter(check => check.status !== "completed");
  if (active.length > 0) {
    return [{ code: "ci_pending", detail: `CI for ${sha} is still running (${active.length} active: ${active.map(check => check.name).slice(0, 5).join(", ")}). Record a ci wait and merge after it finishes.` }];
  }
  const failed = checks.filter(check => check.conclusion !== "skipped" && !PASSING_CONCLUSIONS.has(check.conclusion ?? ""));
  if (failed.length > 0) {
    return [{ code: "ci_failed", detail: `CI for ${sha} did not pass: ${failed.map(check => `${check.name} (${check.conclusion ?? "no conclusion"})`).slice(0, 5).join(", ")}.` }];
  }
  const checkRuns = checks.filter(check => check.kind === "check_run");
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
  for (const scope of input.policy.pathScopedChecks) {
    if (!scope.workflowPath || !scope.checks.some(name => input.requiredChecks.includes(name))) continue;
    if (!provenWorkflowRun({ scope, checks, headSha: input.headSha })) reasons.push({ code: "required_check_skipped", detail:
      `${scope.checks.join(", ")} must all succeed in one completed ${scope.workflowPath} run at ${sha}. Ordinary CI, an older head, skipped jobs or same-named jobs from another workflow do not prove this candidate. The coordinator must reuse or explicitly dispatch the applicable finished-candidate run and record its run ID in a ci wait.` });
  }
  // A skip is allowed only where the policy says so; a path filter that
  // skipped anything else, or a disabled suite, is not a green result.
  const skippablePathScoped = new Set(input.policy.pathScopedChecks.flatMap(scope => scope.checks)
    .filter(name => !input.requiredChecks.includes(name)));
  const touchesWindowsScripts = (input.changedFiles ?? []).some(file => matchesAny(file, WINDOWS_EXECUTED_PATHS));
  for (const check of checkRuns) {
    if (check.conclusion !== "skipped" || reported.has(check.name)) continue;
    if (skippablePathScoped.has(check.name) || matchesAny(check.name, input.policy.optionalSkips)) continue;
    // A plan skip counts only when the plan's validator ran and passed.
    if (input.policy.planValidatedSkips.some(scope =>
      matchesAny(check.name, scope.checks) && passed.some(run => run.name === scope.validator))) continue;
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
export function evaluateBaseCi(input: { baseSha: string; checks: readonly MergeGateCheck[]; policy?: RepositoryMergePolicy }): { red: boolean; failing: string[] } {
  const checks = input.policy ? currentWorkflowChecks({ ...input, policy: input.policy, headSha: input.baseSha }) : input.checks;
  const failing = checks
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
  /** Exhaustive source author agents attested by the independent reviewer, when known. */
  sourceAuthorAgentIds: string[] | null;
  /** When the latest document revision was written; a visual change's candidate must start after it. */
  recordedAt?: string | null;
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

/** A `name: value` line of a review document, with optional list marker and backticks. */
function documentField(body: string, name: string) {
  const match = new RegExp(`^\\s*[-*]?\\s*\`?${name}\`?\\s*:\\s*(.+?)\\s*$`, "im").exec(body);
  return match ? match[1]!.replace(/^`|`$/g, "").trim() : null;
}

/** Parse the `merge-review` document a reviewer writes on its review issue. */
export function parseMergeReviewDocument(body: string): Omit<MergeReviewAttestation,
  "reviewIssueId" | "reviewIssueIdentifier" | "reviewIssueStatus" | "reviewerAgentId" | "reviewerModelFamilies" | "writtenByReviewer" | "recordedAt"> | null {
  const field = (name: string) => documentField(body, name);
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
  const sourceAuthors = field("sourceAuthorAgentIds");
  const sourceAuthorAgentIds = sourceAuthors === null ? null : sourceAuthors.split(/[,\s]+/).filter(Boolean);
  if (sourceAuthorAgentIds !== null && (sourceAuthorAgentIds.length === 0 ||
    sourceAuthorAgentIds.some(id => !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(id)))) return null;
  return { scope, reviewedSha, pullRequest: field("pullRequest"), p0, p1, p2, sourceAuthorAgentIds };
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
  /**
   * Agents that may have authored the change: the assignee and every agent
   * with a run on the task, whatever role it holds now. Null when the runs
   * could not be read.
   */
  agentIds: string[] | null;
  /**
   * Model families that may have authored the change: every run on the task
   * plus commit co-author trailers. Null when provenance is missing.
   */
  modelFamilies: string[] | null;
}

/** Independent: written by its assignee, done, another agent, and another model family. */
function independenceProblem(review: MergeReviewAttestation, author: MergeGateAuthor) {
  if (review.reviewIssueStatus !== "done") return `${reviewLabel(review)} is ${review.reviewIssueStatus}, not done.`;
  if (!review.writtenByReviewer || !review.reviewerAgentId) return `${reviewLabel(review)}'s merge-review document was not written by its assigned reviewer.`;
  if (!author.agentIds) {
    return `The gate found no recorded model provenance for the agents that worked on this task, so it cannot show ${reviewLabel(review)} is independent.`;
  }
  if (author.agentIds.includes(review.reviewerAgentId)) {
    return `${reviewLabel(review)} was reviewed by an agent that worked on this task and may have authored part of the change.`;
  }
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
export function evaluateReviewCoverage(input: Parameters<typeof reviewCoverage>[0]): MergeGateReason[] {
  return reviewCoverage(input).reasons;
}

/** `evaluateReviewCoverage`, plus the reviews that cover the head (the code review a candidate must follow). */
export function reviewCoverage(input: {
  pullRequest: string;
  headSha: string;
  author: MergeGateAuthor;
  reviews: readonly MergeReviewAttestation[];
  deltaFor: (reviewedSha: string) => HeadDelta;
}): { reasons: MergeGateReason[]; covering: MergeReviewAttestation[] } {
  const sha = shortSha(input.headSha);
  const forThisPr = input.reviews.filter(review => !review.pullRequest ||
    review.pullRequest.toLowerCase() === input.pullRequest.toLowerCase());
  const full = forThisPr.filter(review => review.scope === "full");
  if (full.length === 0) {
    return { covering: [], reasons: [{ code: "review_missing", detail: `No independent review with a merge-review document (scope full) is linked for ${input.pullRequest}.` }] };
  }
  const reasons: MergeGateReason[] = [];
  const independentFull = full.filter(review => {
    const problem = independenceProblem(review, input.author);
    if (problem) reasons.push({ code: "review_not_independent", detail: problem });
    return !problem;
  });
  if (independentFull.length === 0) return { reasons, covering: [] };
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
    return { covering: [], reasons: [{ code: "review_stale", detail: `The review covers ${shortSha(latest.reviewedSha)}, but the source changed before ${sha}${delta.kind === "source_changed" ? `: ${delta.detail}` : ""}. Review the new head.` }] };
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
  return { reasons, covering };
}

/**
 * Every path a change touches: each file's name and, for a rename or copy,
 * its previous name too. Moving a file out of a scoped directory changes
 * that directory as much as editing it does.
 */
export function changedPaths(files: readonly PullRequestFileDiff[] | null): string[] | null {
  if (!files) return null;
  return [...new Set(files.flatMap(file => file.previousFilename ? [file.filename, file.previousFilename] : [file.filename]))];
}

/**
 * Whether a change needs a visual review: it touches one of the repository's
 * visual paths, or its file list is empty or unreadable (unknown).
 */
export function requiresVisualReview(input: { policy: RepositoryMergePolicy; changedFiles: readonly string[] | null }): boolean {
  const paths = input.policy.visualPaths;
  if (!paths || paths.length === 0) return false;
  const files = input.changedFiles;
  return files === null || files.length === 0 || files.some(file => matchesAny(file, paths));
}

export interface VisualReviewAttestation {
  reviewIssueId: string;
  reviewIssueIdentifier: string | null;
  reviewIssueStatus: string;
  reviewerAgentId: string | null;
  /** The document revision was written by the review issue's assignee, in one of its own runs. */
  writtenByReviewer: boolean;
  /**
   * The writer is a designated visual reviewer
   * (`runtimeConfig.mergeGate.visualReviewer: true`) and not terminated.
   */
  designatedReviewer: boolean;
  /** When the latest document revision was written. */
  recordedAt: string | null;
  reviewedSha: string;
  pullRequest: string | null;
  /** The candidate workflow run (and attempt) whose evidence the verdict judges. */
  candidateRunId: number;
  candidateRunAttempt: number;
  verdict: "pass" | "fail";
}

/** Parse the `visual-review` document a visual reviewer writes on its review issue. */
export function parseVisualReviewDocument(body: string): Pick<VisualReviewAttestation,
  "reviewedSha" | "pullRequest" | "verdict" | "candidateRunId" | "candidateRunAttempt"> | null {
  const field = (name: string) => documentField(body, name);
  const reviewedSha = field("reviewedSha")?.toLowerCase() ?? null;
  if (!reviewedSha || !/^[0-9a-f]{40}$/.test(reviewedSha)) return null;
  const verdict = field("verdict")?.toLowerCase() ?? null;
  if (verdict !== "pass" && verdict !== "fail") return null;
  const runId = field("candidateRunId");
  const attempt = field("candidateRunAttempt") ?? "1";
  if (!runId || !/^[1-9]\d*$/.test(runId) || !/^[1-9]\d*$/.test(attempt)) return null;
  return { reviewedSha, pullRequest: field("pullRequest"), verdict, candidateRunId: Number(runId), candidateRunAttempt: Number(attempt) };
}

/**
 * Visual review for the exact merge head, in Ethan's order: code review, then
 * one candidate run, then a visual verdict on that run's evidence. The verdict
 * must be done, written by its assigned reviewer in its own run, that
 * reviewer a designated visual reviewer who did not work on the task, and
 * passing. It names the admitted candidate run and attempt and was recorded
 * after that run finished; the run started after every covering code review
 * was recorded. Unlike the code review, a clean base update does not carry
 * the verdict forward: the candidate must run on the head that merges. The
 * newest verdict at that head decides.
 */
export function evaluateVisualReview(input: {
  pullRequest: string;
  headSha: string;
  required: boolean;
  author: MergeGateAuthor;
  reviews: readonly VisualReviewAttestation[];
  /** `admittedCandidateRun` at the head. */
  candidate: AdmittedCandidateRun | null;
  /** Code reviews covering the head (`reviewCoverage`); empty when coverage already refused. */
  codeReviews: readonly MergeReviewAttestation[];
}): MergeGateReason[] {
  if (!input.required) return [];
  const sha = shortSha(input.headSha);
  const label = (review: VisualReviewAttestation) => review.reviewIssueIdentifier ?? review.reviewIssueId;
  const forThisPr = input.reviews.filter(review => !review.pullRequest ||
    review.pullRequest.toLowerCase() === input.pullRequest.toLowerCase());
  if (forThisPr.length === 0) {
    return [{ code: "visual_review_missing", detail: `${input.pullRequest} changes what the user sees, so it needs a visual review of its Internal Windows candidate evidence at ${sha}: a done review issue assigned to a designated visual reviewer, with a visual-review document (pullRequest, reviewedSha, candidateRunId, candidateRunAttempt, verdict pass|fail) that reviewer wrote after the candidate run finished. Pass that review issue in reviewIssueIds.` }];
  }
  const problems: MergeGateReason[] = [];
  const independent = forThisPr.filter(review => {
    const problem = review.reviewIssueStatus !== "done" ? `${label(review)} is ${review.reviewIssueStatus}, not done.`
      : !review.writtenByReviewer || !review.reviewerAgentId ? `${label(review)}'s visual-review document was not written by its assigned reviewer in one of that reviewer's runs.`
        : !review.designatedReviewer ? `${label(review)} was written by an agent that is not a designated visual reviewer (runtimeConfig.mergeGate.visualReviewer). Assign the visual review to the Portfolio Visual Reviewer.`
          : !input.author.agentIds ? `The gate could not read which agents worked on this task, so it cannot show ${label(review)} is independent.`
            : input.author.agentIds.includes(review.reviewerAgentId) ? `${label(review)} was visually reviewed by an agent that worked on this task.`
              : null;
    if (problem) problems.push({ code: "visual_review_not_independent", detail: problem });
    return !problem;
  });
  if (independent.length === 0) return problems;
  const atHead = independent.filter(review => review.reviewedSha === input.headSha.toLowerCase());
  const latest = atHead[atHead.length - 1];
  if (!latest) {
    const newest = independent[independent.length - 1]!;
    return [{ code: "visual_review_stale", detail: `The visual review ${label(newest)} covers ${shortSha(newest.reviewedSha)}, but the merge head is ${sha}. Run the Internal Windows candidate on ${sha} and visually review that evidence.` }];
  }
  if (latest.verdict !== "pass") {
    return [{ code: "visual_review_failed", detail: `The visual review ${label(latest)} failed ${sha} against its visual brief. Fix the findings, then rerun CI, the code review as needed, the candidate and the visual review on the new head.` }];
  }
  // Without a proven candidate the CI reasons already refuse; the verdict has nothing to bind to.
  const candidate = input.candidate;
  if (!candidate) return [];
  if (latest.candidateRunId !== candidate.runId || latest.candidateRunAttempt !== candidate.runAttempt) {
    return [{ code: "visual_review_unbound", detail: `The visual review ${label(latest)} judges candidate run ${latest.candidateRunId} attempt ${latest.candidateRunAttempt}, but the candidate the gate admits at ${sha} is run ${candidate.runId} attempt ${candidate.runAttempt}. Visually review that run's evidence.` }];
  }
  const reasons: MergeGateReason[] = [];
  const started = parsedTime(candidate.startedAt);
  const finished = parsedTime(candidate.completedAt);
  const verdictAt = parsedTime(latest.recordedAt);
  if (finished === null || verdictAt === null || verdictAt <= finished) {
    reasons.push({ code: "review_order_invalid", detail: finished === null || verdictAt === null
      ? `The gate could not read when candidate run ${candidate.runId} finished or when ${label(latest)} was recorded, so it cannot show the visual verdict followed the candidate.`
      : `The visual review ${label(latest)} was recorded before candidate run ${candidate.runId} finished. Visually review the finished run's evidence and record the verdict again.` });
  }
  const reviewTimes = input.codeReviews.map(review => ({ review, at: parsedTime(review.recordedAt) }));
  if (started === null || reviewTimes.some(entry => entry.at === null)) {
    reasons.push({ code: "review_order_invalid", detail: `The gate could not read when candidate run ${candidate.runId} started or when its code review was recorded, so it cannot show the candidate followed the code review.` });
  } else {
    const early = reviewTimes.filter(entry => entry.at! >= started).map(entry => reviewLabel(entry.review));
    if (early.length > 0) reasons.push({ code: "review_order_invalid", detail: `Candidate run ${candidate.runId} started before the code review ${early.join(", ")} was recorded. The candidate runs after a clean code review: rerun it on ${sha}, then visually review the new run.` });
  }
  return reasons;
}

/** Normalize a unified diff so line-number shifts from base updates compare equal. */
export function normalizePatch(patch: string) {
  return patch.split("\n").map(line => line.startsWith("@@") ? "@@" : line).join("\n");
}

export interface PullRequestFileDiff {
  filename: string;
  /** A rename's or copy's previous name. */
  previousFilename?: string | null;
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
  visualReasons?: readonly MergeGateReason[];
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
  reasons.push(...input.ciReasons, ...input.reviewReasons, ...(input.visualReasons ?? []));
  return { mergeable: reasons.length === 0, reasons, requiredChecks: [...input.requiredChecks] };
}

