import { describe, expect, it, vi } from "vitest";
import type { MergeGateGitHub } from "./github.js";
import type { MergeGateCheck, MergeReviewAttestation, PullRequestFileDiff, VisualReviewAttestation } from "./policy.js";
import { coAuthorModelFamilies, evaluateAndMerge, MERGE_LOCK_BUSY, reportRedMain, type GateIssue, type MergeGateDependencies } from "./service.js";

const HEAD = "a".repeat(40);
const REVIEWED = "b".repeat(40);
const BASE = "c".repeat(40);
const NEW_BASE = "e".repeat(40);
const COMPANY = "company-1";
// Ethan's order for a visual change: code review, evidence run, visual verdict.
// For Facette the evidence run is the UI browser smoke run (FAC-1053). The
// candidate's times differ from the smoke run's so a test can tell which run
// the gate compared against.
const CODE_REVIEWED_AT = "2026-11-13T01:00:00.000Z";
const CANDIDATE_STARTED_AT = "2026-11-13T02:00:00.000Z";
const CANDIDATE_FINISHED_AT = "2026-11-13T02:40:00.000Z";
const SMOKE_STARTED_AT = "2026-11-13T02:10:00.000Z";
const SMOKE_FINISHED_AT = "2026-11-13T02:50:00.000Z";
const VISUAL_REVIEWED_AT = "2026-11-13T03:00:00.000Z";
const CANDIDATE_RUN_ID = 1234;
const SMOKE_RUN_ID = 5678;

const ok = (name: string): MergeGateCheck => ({ kind: "check_run", name, status: "completed", conclusion: "success" });

function issue(overrides: Partial<GateIssue> & { id: string }): GateIssue {
  return {
    companyId: COMPANY, identifier: overrides.id.toUpperCase(), title: overrides.id, status: "in_review", priority: "high",
    projectId: "project-1", parentId: null, assigneeAgentId: null, createdByAgentId: null,
    originKind: "manual", originId: null, ...overrides,
  };
}

/** One repository's base branch, shared by every pull request's fake. */
function fakeBase() {
  return { head: BASE };
}

function fakeGitHub(overrides: Partial<{ baseChecks: MergeGateCheck[]; headChecks: MergeGateCheck[]; behindBy: number; headSha: string; base: { head: string }; commitMessage: string }> = {}) {
  const headSha = overrides.headSha ?? HEAD;
  const base = overrides.base ?? fakeBase();
  // Merging advances the shared base, as GitHub would.
  const merge = vi.fn(async () => { base.head = NEW_BASE; return { merged: true, sha: NEW_BASE, message: "Pull Request successfully merged" }; });
  const github: MergeGateGitHub = {
    pullRequest: async () => ({ state: "open", merged: false, draft: false, headSha, headRef: "sta-1", baseRef: "main", mergeable: true, mergeableState: "clean" }),
    branchHead: async () => base.head,
    compare: async (from, to) => {
      if (from === REVIEWED && to === HEAD) {
        return { status: "ahead", aheadBy: 3, behindBy: 0, totalCommits: 3, complete: true, files: [],
          commits: [{ sha: "m1", parentCount: 1 }, { sha: "m2", parentCount: 1 }, { sha: "merge", parentCount: 2 }] };
      }
      if (from === REVIEWED && to === BASE) {
        return { status: "ahead", aheadBy: 2, behindBy: 0, totalCommits: 2, complete: true, files: [],
          commits: [{ sha: "m1", parentCount: 1 }, { sha: "m2", parentCount: 1 }] };
      }
      if (to === headSha) {
        // compare(base...head): a head built on BASE is behind any newer base.
        return { status: "ahead", aheadBy: 3, behindBy: from === BASE ? (overrides.behindBy ?? 0) : 1, totalCommits: 3, files: [], complete: true,
          commits: [{ sha: "own", parentCount: 1, message: overrides.commitMessage ?? "feat: change\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" }] };
      }
      // compare(base...reviewed): the PR's own diff at review time.
      return { status: "diverged", aheadBy: 1, behindBy: 2, totalCommits: 1, complete: true, commits: [],
        files: [{ filename: "account-web/app/page.tsx", status: "modified", blobSha: "x1", patch: "@@ -1 +1 @@\n-a\n+b" }] };
    },
    pullRequestFiles: async () => [{ filename: "account-web/app/page.tsx", status: "modified", blobSha: "x2", patch: "@@ -4 +4 @@\n-a\n+b" }],
    checks: async sha => ({ complete: true, checks: sha === headSha ? (overrides.headChecks ?? [ok("verify"), ok("shell")]) : (overrides.baseChecks ?? [ok("verify")]) }),
    merge,
  };
  return { github, merge, base };
}

function review(overrides: Partial<MergeReviewAttestation> = {}): MergeReviewAttestation {
  return {
    reviewIssueId: "review", reviewIssueIdentifier: "STA-REVIEW", reviewIssueStatus: "done", reviewerAgentId: "codex-reviewer",
    reviewerModelFamilies: ["openai"], writtenByReviewer: true, sourceAuthorAgentIds: null, scope: "full", reviewedSha: HEAD,
    pullRequest: "ethanmonlux/facette#704", p0: 0, p1: 0, p2: [], recordedAt: CODE_REVIEWED_AT, ...overrides,
  };
}

function visualReview(overrides: Partial<VisualReviewAttestation> = {}): VisualReviewAttestation {
  return {
    reviewIssueId: "visual", reviewIssueIdentifier: "STA-VISUAL", reviewIssueStatus: "done", reviewerAgentId: "visual-reviewer",
    writtenByReviewer: true, designatedReviewer: true, recordedAt: VISUAL_REVIEWED_AT, reviewedSha: HEAD,
    // The document's field names are unchanged; for Facette they hold the smoke run's id and attempt.
    pullRequest: "ethanmonlux/facette#704", candidateRunId: SMOKE_RUN_ID, candidateRunAttempt: 1, verdict: "pass", ...overrides,
  };
}

function harness(input: {
  github: MergeGateGitHub | ((repo: string) => MergeGateGitHub); reviews?: MergeReviewAttestation[]; issues?: GateIssue[];
  visualReviews?: VisualReviewAttestation[];
  authorFamilies?: string[] | null; authorAgents?: string[]; coordinatorFamilies?: string[]; locks?: Set<string>; onLoadReviews?: () => void;
  legacyCoordinator?: string;
  routedCoordinator?: string;
  /** The task's recorded creator/assignee/checkout history; defaults to its creator and assignee. */
  custodians?: string[] | null;
  /** Started runs on the task per agent, read with the real wiring's filtering. */
  runFamilies?: Record<string, string[]>;
}) {
  const issues = new Map((input.issues ?? []).map(row => [row.id, row]));
  issues.set("task", issues.get("task") ?? issue({ id: "task", assigneeAgentId: "claude-engineer", createdByAgentId: "coordinator", parentId: "parent" }));
  issues.set("parent", issues.get("parent") ?? issue({ id: "parent", assigneeAgentId: "lead-coordinator" }));
  const owners = new Map<string, GateIssue>();
  const parked: Array<{ issueId: string; blockerIssueId: string }> = [];
  const logs: Array<{ action: string; details: Record<string, unknown> }> = [];
  const locks = input.locks ?? new Set<string>();
  const authorQueries: Array<{ issueId: string; excludeAgentId: string | null; sourceAuthorAgentIds?: string[]; attesterAgentId?: string }> = [];
  const custodianQueries: string[] = [];
  const visualQueries: boolean[] = [];
  const deps: MergeGateDependencies = {
    github: repo => typeof input.github === "function" ? input.github(repo) : input.github,
    resolveToken: async () => "token",
    loadIssue: async (_company, id) => issues.get(id) ?? null,
    loadLegacyDelegation: async (_company, _issueId, agentId) => input.legacyCoordinator === agentId,
    loadAcceptedCoordinatorRouting: async (_company, _issueId, _implementerId, agentId) => input.routedCoordinator === agentId,
    loadTaskAuthorship: async (_company, query) => {
      authorQueries.push(query);
      if (input.runFamilies) {
        const counted = query.sourceAuthorAgentIds && [...query.sourceAuthorAgentIds, ...(query.attesterAgentId ? [query.attesterAgentId] : [])];
        const ran = Object.keys(input.runFamilies)
          .filter(id => (!counted || counted.includes(id)) && id !== query.excludeAgentId).sort();
        if (query.sourceAuthorAgentIds?.some(id => !ran.includes(id))) return null;
        return { agentIds: ran, modelFamilies: [...new Set(ran.flatMap(id => input.runFamilies![id]!))].sort() };
      }
      const families = input.authorFamilies === undefined ? ["anthropic"] : input.authorFamilies;
      // `coordinatorFamilies` means the coordinator has runs on the task.
      const coordinatorRuns = input.coordinatorFamilies && query.excludeAgentId !== "coordinator";
      return families === null ? null : {
        agentIds: query.sourceAuthorAgentIds ?? [...(input.authorAgents ?? ["claude-engineer"]), ...(coordinatorRuns ? ["coordinator"] : [])],
        modelFamilies: query.sourceAuthorAgentIds ? families : [...families, ...(coordinatorRuns ? input.coordinatorFamilies ?? [] : [])],
      };
    },
    loadTaskCustodians: async (_company, issueId) => {
      custodianQueries.push(issueId);
      if (input.custodians !== undefined) return input.custodians;
      const task = issues.get(issueId);
      return [task?.createdByAgentId, task?.assigneeAgentId].filter((id): id is string => Boolean(id));
    },
    // The database lock is a try-lock shared across server instances.
    withMergeLock: async (key, action) => {
      if (locks.has(key)) return MERGE_LOCK_BUSY;
      locks.add(key);
      try { return await action(); } finally { locks.delete(key); }
    },
    loadReviews: async () => { input.onLoadReviews?.(); return input.reviews ?? [review()]; },
    loadVisualReviews: async () => { visualQueries.push(true); return input.visualReviews ?? []; },
    ensureRedMainIssue: async request => {
      const key = `${request.repo}:${request.baseRef}`;
      const existing = owners.get(key);
      if (existing) return { issue: existing, created: false };
      if (!request.createIfMissing) return null;
      const owner = issue({ id: `red-main-${owners.size + 1}`, priority: "critical", status: "todo", assigneeAgentId: "repair-engineer",
        originKind: "merge_gate_red_main", originId: key });
      owners.set(key, owner);
      issues.set(owner.id, owner);
      return { issue: owner, created: true };
    },
    parkOnIssue: async request => { parked.push({ issueId: request.issueId, blockerIssueId: request.blockerIssueId }); },
    log: async entry => { logs.push({ action: entry.action, details: entry.details }); },
  };
  return { deps, issues, owners, parked, logs, authorQueries, custodianQueries, visualQueries };
}

const coordinator = { type: "agent" as const, agentId: "coordinator", runId: "run-1" };
const request = (overrides: Partial<Parameters<typeof evaluateAndMerge>[1]> = {}) => ({
  companyId: COMPANY, issueId: "task", repo: "ethanmonlux/facette", pullNumber: 704, actor: coordinator, ...overrides,
});
// A ready Facette code pull request: the four always-run checks and the three code suites.
const facetteAlwaysCi = [ok("changes"), ok("shell"), ok("agent"), ok("account-web"), ok("pr-status-block"), ok("gate / gate"), ok("ready / summary")];
/** Facette's code suites: needed unless every changed file is on its SAFE_PATHS list. */
const CODE = ["shell", "agent", "account-web"];
const accountWebCi = [...facetteAlwaysCi,
  { kind: "check_run" as const, name: "windows-fast", status: "completed", conclusion: "skipped" }];

describe("merge gate service", () => {
  describe("Facette visual changes (STA-362, FAC-1053)", () => {
    const ordinary = [...facetteAlwaysCi, ok("windows-fast"), ok("windows-native")];
    const WINDOWS = ["windows-fast", "windows-native"];
    // The Internal Windows candidate: `frontend` and `candidate`, no `browser-evidence` job.
    const candidateAt = (sha: string, run: Partial<MergeGateCheck> = {}): MergeGateCheck[] => [
      ...["frontend", "candidate"].map(name => ({ ...ok(name), headSha: sha, checkSuiteId: 91,
        startedAt: CANDIDATE_STARTED_AT, completedAt: CANDIDATE_FINISHED_AT })),
      { kind: "workflow_run", name: "Internal Windows Candidate", status: "completed", conclusion: "success",
        headSha: sha, checkSuiteId: 91, runId: CANDIDATE_RUN_ID, runAttempt: 1, startedAt: CANDIDATE_STARTED_AT,
        workflowPath: ".github/workflows/internal-windows.yml", ...run },
    ];
    // The UI browser smoke run: one `smoke` job. Its captures are what the visual verdict judges.
    const smokeAt = (sha: string, run: Partial<MergeGateCheck> = {}, job: Partial<MergeGateCheck> = {}): MergeGateCheck[] => [
      { ...ok("smoke"), headSha: sha, checkSuiteId: 93, startedAt: SMOKE_STARTED_AT, completedAt: SMOKE_FINISHED_AT, ...job },
      { kind: "workflow_run", name: "UI browser smoke", status: "completed", conclusion: "success",
        headSha: sha, checkSuiteId: 93, runId: SMOKE_RUN_ID, runAttempt: 1, startedAt: SMOKE_STARTED_AT,
        workflowPath: ".github/workflows/ui-browser-smoke.yml", ...run },
    ];
    const evidenceAt = (sha: string) => [...candidateAt(sha), ...smokeAt(sha)];
    const changed = (filename: string): PullRequestFileDiff => ({ filename, status: "modified", blobSha: "x", patch: "@@ -1 +1 @@\n-a\n+b" });
    const kaia = changed("shell/faces/osrs/character/kaia/KaiaRive.tsx");
    const visualGitHub = (evidence: MergeGateCheck[], files: PullRequestFileDiff[] = [kaia]) => {
      const fake = fakeGitHub({ headChecks: [...ordinary, ...evidence] });
      fake.github.pullRequestFiles = async () => files;
      return fake;
    };
    const codes = (result: { reasons: Array<{ code: string }> }) => result.reasons.map(reason => reason.code);
    const details = (result: { reasons: Array<{ detail: string }> }) => result.reasons.map(reason => reason.detail).join("\n");

    it("refuses a code-reviewed visual change without an exact-head candidate", async () => {
      // The smoke run and its verdict do not stand in for the candidate.
      const { github, merge } = visualGitHub(smokeAt(HEAD));
      const result = await evaluateAndMerge(harness({ github, visualReviews: [visualReview()] }).deps, request());
      expect(result.outcome).toBe("refused");
      expect(codes(result)).toEqual(["required_check_skipped", "required_check_skipped", "required_check_skipped"]);
      expect(details(result)).toMatch(/internal-windows\.yml run at aaaaaaaaaaaa/);
      expect(details(result)).not.toMatch(/ui-browser-smoke/);
      expect(merge).not.toHaveBeenCalled();
    });

    it("refuses a UI change with a green candidate but no smoke run at the head (FAC-1053)", async () => {
      // With a verdict, and with none: the missing run is a CI refusal either way.
      // A passing verdict is refused as well: there is no proven smoke run for it to name.
      for (const [visualReviews, expected] of [
        [[visualReview()], ["required_check_skipped", "required_check_skipped", "visual_review_unbound"]],
        // A verdict that names the candidate run finds no smoke run to bind to.
        [[visualReview({ candidateRunId: CANDIDATE_RUN_ID })], ["required_check_skipped", "required_check_skipped", "visual_review_unbound"]],
        [[], ["required_check_skipped", "required_check_skipped", "visual_review_missing"]],
      ] as const) {
        const { github, merge } = visualGitHub(candidateAt(HEAD));
        const result = await evaluateAndMerge(harness({ github, visualReviews: [...visualReviews] }).deps, request());
        expect(result.outcome).toBe("refused");
        expect(codes(result)).toEqual(expected);
        expect(result.requiredChecks).toEqual([...CODE, ...WINDOWS, "frontend", "candidate", "smoke"]);
        expect(result.reasons[0]!.detail).toBe("smoke did not run on aaaaaaaaaaaa, but this change needs it. It must run and pass.");
        expect(result.reasons[1]!.detail).toMatch(/^smoke must all succeed in one completed \.github\/workflows\/ui-browser-smoke\.yml run at aaaaaaaaaaaa\./);
        // It does not send the coordinator to dispatch another candidate.
        expect(result.reasons[1]!.detail).not.toMatch(/candidate/i);
        if (visualReviews.length > 0) {
          expect(result.reasons[2]!.detail).toBe(`The visual review STA-VISUAL judges run ${visualReviews[0]!.candidateRunId} attempt 1, but there is no proven UI browser smoke run at aaaaaaaaaaaa for the verdict to name. That run must finish successfully at aaaaaaaaaaaa; then visually review its evidence.`);
        }
        expect(merge).not.toHaveBeenCalled();
      }
    });

    it("refuses a visual change whose candidate ran on another head", async () => {
      const { github, merge } = visualGitHub([...candidateAt(REVIEWED), ...smokeAt(HEAD)]);
      const result = await evaluateAndMerge(harness({ github, visualReviews: [visualReview()] }).deps, request());
      expect(result.outcome).toBe("refused");
      expect(codes(result)).toEqual(["required_check_skipped"]);
      expect(details(result)).toMatch(/internal-windows\.yml run at aaaaaaaaaaaa/);
      expect(merge).not.toHaveBeenCalled();
    });

    it("does not count a smoke run that failed, is still running, or belongs to an older head (FAC-1053)", async () => {
      const running = { status: "in_progress", conclusion: null };
      const cases: Array<[string, MergeGateCheck[], string[]]> = [
        ["a smoke run on an older head", smokeAt(REVIEWED), ["required_check_skipped"]],
        ["a smoke run at the head whose job ran on an older head", smokeAt(HEAD, {}, { headSha: REVIEWED }), ["required_check_skipped"]],
        ["a failed smoke run", smokeAt(HEAD, { conclusion: "failure" }, { conclusion: "failure" }), ["ci_failed"]],
        ["a failed smoke job in a run reported successful", smokeAt(HEAD, {}, { conclusion: "failure" }), ["ci_failed"]],
        ["a cancelled smoke run", smokeAt(HEAD, { conclusion: "cancelled" }, { conclusion: "cancelled" }), ["ci_failed"]],
        ["a smoke run still running", smokeAt(HEAD, running, running), ["ci_pending"]],
        ["a queued smoke run with no job yet", smokeAt(HEAD, { status: "queued", conclusion: null }).slice(1), ["ci_pending"]],
        ["a smoke run the path filter skipped", smokeAt(HEAD, { conclusion: "skipped" }, { conclusion: "skipped" }),
          ["required_check_skipped", "required_check_skipped"]],
        ["a smoke job in another workflow's run", smokeAt(HEAD, { workflowPath: ".github/workflows/ci.yml" }), ["required_check_skipped"]],
        ["a newer failed smoke run after a successful one", [...smokeAt(HEAD, { createdAt: "2026-11-13T02:10:00Z" }),
          ...smokeAt(HEAD, { runId: 5679, checkSuiteId: 94, conclusion: "failure", createdAt: "2026-11-13T04:00:00Z" },
            { checkSuiteId: 94, conclusion: "failure" })], ["ci_failed"]],
      ];
      for (const [name, smoke, expected] of cases) {
        // The verdict names the smoke run's id and attempt, and the candidate is green: only the smoke run is wrong.
        const { github, merge } = visualGitHub([...candidateAt(HEAD), ...smoke]);
        const result = await evaluateAndMerge(harness({ github, visualReviews: [visualReview()] }).deps, request());
        // The CI reason, and in every case the passing verdict has no proven smoke run to name.
        expect({ name, outcome: result.outcome, codes: codes(result) }).toEqual({ name, outcome: "refused", codes: [...expected, "visual_review_unbound"] });
        expect(result.reasons.at(-1)!.detail, name).toContain("there is no proven UI browser smoke run at aaaaaaaaaaaa for the verdict to name");
        expect(details(result), name).toMatch(/smoke/i);
        expect(merge, name).not.toHaveBeenCalled();
      }
    });

    it("refuses a visual change with a candidate and a smoke run but no visual verdict", async () => {
      const { github, merge } = visualGitHub(evidenceAt(HEAD));
      const result = await evaluateAndMerge(harness({ github }).deps, request());
      expect(result).toMatchObject({ outcome: "refused", reasons: [{ code: "visual_review_missing" }] });
      expect(codes(result)).toEqual(["visual_review_missing"]);
      // Facette's evidence run is named in the refusal; the candidate is not.
      expect(result.reasons[0]!.detail).toContain("needs a visual review of its UI browser smoke evidence at aaaaaaaaaaaa");
      expect(result.reasons[0]!.detail).toContain("candidateRunId and candidateRunAttempt naming that UI browser smoke run");
      expect(result.reasons[0]!.detail).not.toMatch(/Internal Windows|candidate run/i);
      expect(merge).not.toHaveBeenCalled();
    });

    it("refuses a failing, stale, unfinished or non-independent visual verdict", async () => {
      const cases: Array<[VisualReviewAttestation[], string]> = [
        [[visualReview({ verdict: "fail" })], "visual_review_failed"],
        // A pass on an older head does not outweigh a failure at the merge head.
        [[visualReview({ verdict: "fail" }), visualReview({ reviewedSha: REVIEWED })], "visual_review_failed"],
        [[visualReview({ reviewedSha: REVIEWED })], "visual_review_stale"],
        [[visualReview({ reviewIssueStatus: "in_progress" })], "visual_review_not_independent"],
        [[visualReview({ writtenByReviewer: false })], "visual_review_not_independent"],
        [[visualReview({ reviewerAgentId: "claude-engineer" })], "visual_review_not_independent"],
        // An independent agent that is not the designated visual reviewer (FAC-939).
        [[visualReview({ reviewerAgentId: "backend-engineer", designatedReviewer: false })], "visual_review_not_independent"],
        [[visualReview({ pullRequest: "ethanmonlux/facette#705" })], "visual_review_missing"],
      ];
      for (const [visualReviews, code] of cases) {
        const { github, merge } = visualGitHub(evidenceAt(HEAD));
        const result = await evaluateAndMerge(harness({ github, visualReviews }).deps, request());
        expect(result.outcome).toBe("refused");
        expect(codes(result)).toEqual([code]);
        if (code === "visual_review_failed" || code === "visual_review_stale") {
          expect(result.reasons[0]!.detail).toContain("the UI browser smoke");
          expect(result.reasons[0]!.detail).not.toMatch(/Internal Windows|candidate/i);
        }
        expect(merge).not.toHaveBeenCalled();
      }
    });

    it("binds the visual verdict to the admitted smoke run and Ethan's order (FAC-940, FAC-1053)", async () => {
      const cases: Array<[string, MergeGateCheck[], VisualReviewAttestation, MergeReviewAttestation, string]> = [
        // 02:45 is after the candidate finished (02:40) and before the smoke run did (02:50).
        ["a verdict recorded after the candidate finished but before the smoke run did", smokeAt(HEAD), visualReview({ recordedAt: "2026-11-13T02:45:00.000Z" }), review(),
          "review_order_invalid"],
        ["a verdict recorded the instant the smoke run finished", smokeAt(HEAD), visualReview({ recordedAt: SMOKE_FINISHED_AT }), review(),
          "review_order_invalid"],
        ["a verdict naming the candidate run at the same head", smokeAt(HEAD), visualReview({ candidateRunId: CANDIDATE_RUN_ID }), review(),
          "visual_review_unbound"],
        ["a verdict on another run at the same head", smokeAt(HEAD), visualReview({ candidateRunId: 999 }), review(),
          "visual_review_unbound"],
        ["a verdict on an earlier attempt of the admitted smoke run", smokeAt(HEAD, { runAttempt: 2 }), visualReview(), review(),
          "visual_review_unbound"],
        // 02:15 is after both runs started (02:00 and 02:10).
        ["a smoke run started before the code review was recorded", smokeAt(HEAD), visualReview(),
          review({ recordedAt: "2026-11-13T02:15:00.000Z" }), "review_order_invalid"],
        ["a smoke run started the instant the code review was recorded", smokeAt(HEAD), visualReview(),
          review({ recordedAt: SMOKE_STARTED_AT }), "review_order_invalid"],
        ["a smoke job started before the code review though its run attempt started after", smokeAt(HEAD, { startedAt: "2026-11-13T02:20:00.000Z" }), visualReview(),
          review({ recordedAt: "2026-11-13T02:15:00.000Z" }), "review_order_invalid"],
        ["a code review with no recorded time", smokeAt(HEAD), visualReview(), review({ recordedAt: null }), "review_order_invalid"],
        ["a smoke run with no recorded start", smokeAt(HEAD, { startedAt: null }), visualReview(), review(), "review_order_invalid"],
        ["a smoke job with no recorded start", smokeAt(HEAD, {}, { startedAt: null }), visualReview(), review(), "review_order_invalid"],
        ["a smoke job with no recorded finish", smokeAt(HEAD, {}, { completedAt: null }), visualReview(), review(), "review_order_invalid"],
        ["a verdict with no recorded time", smokeAt(HEAD), visualReview({ recordedAt: null }), review(), "review_order_invalid"],
      ];
      for (const [name, smoke, visual, code, reason] of cases) {
        const { github, merge } = visualGitHub([...candidateAt(HEAD), ...smoke]);
        const result = await evaluateAndMerge(harness({ github, reviews: [code], visualReviews: [visual] }).deps, request());
        expect({ name, outcome: result.outcome, codes: codes(result) }).toEqual({ name, outcome: "refused", codes: [reason] });
        expect(result.reasons[0]!.detail, name).toContain("UI browser smoke run");
        expect(result.reasons[0]!.detail, name).not.toMatch(/Internal Windows|candidate/i);
        expect(merge).not.toHaveBeenCalled();
      }
      // The unbound refusal tells the reviewer which run to judge.
      const unbound = visualGitHub(evidenceAt(HEAD));
      const refused = await evaluateAndMerge(harness({ github: unbound.github, visualReviews: [visualReview({ candidateRunId: CANDIDATE_RUN_ID })] }).deps, request());
      expect(refused.reasons).toEqual([{ code: "visual_review_unbound",
        detail: `The visual review STA-VISUAL judges run ${CANDIDATE_RUN_ID} attempt 1, but the UI browser smoke run the gate admits at aaaaaaaaaaaa is run ${SMOKE_RUN_ID} attempt 1. Visually review that run's evidence.` }]);
      // A smoke run that started too early names both ways to get one that follows the review.
      const early = visualGitHub(evidenceAt(HEAD));
      const tooEarly = await evaluateAndMerge(harness({ github: early.github, reviews: [review({ recordedAt: "2026-11-13T02:15:00.000Z" })],
        visualReviews: [visualReview()] }).deps, request());
      expect(tooEarly.reasons).toEqual([{ code: "review_order_invalid",
        detail: `UI browser smoke run ${SMOKE_RUN_ID} started before the code review STA-REVIEW was recorded. It runs after a clean code review: re-run the workflow on aaaaaaaaaaaa, or set the pull request to draft and ready again, then visually review the new run.` }]);
      // A rerun attempt started after the code review, with its verdict naming that attempt, merges.
      const { github, merge } = visualGitHub([...candidateAt(HEAD), ...smokeAt(HEAD, { runAttempt: 2 })]);
      await expect(evaluateAndMerge(harness({ github, visualReviews: [visualReview({ candidateRunAttempt: 2 })] }).deps, request()))
        .resolves.toMatchObject({ outcome: "merged", reasons: [] });
      expect(merge).toHaveBeenCalledTimes(1);
    });

    it("takes the order from the smoke run alone: the candidate's attempt and times are not compared (FAC-1053)", async () => {
      // The candidate (started 02:00, finished 02:40) started before this
      // code review (02:05) and is on attempt 3; the smoke run started after
      // it (02:10), and the verdict names the smoke run. The gate merges.
      const { github, merge } = visualGitHub([...candidateAt(HEAD, { runAttempt: 3 }), ...smokeAt(HEAD)]);
      await expect(evaluateAndMerge(harness({ github, reviews: [review({ recordedAt: "2026-11-13T02:05:00.000Z" })],
        visualReviews: [visualReview()] }).deps, request())).resolves.toMatchObject({ outcome: "merged", reasons: [] });
      expect(merge).toHaveBeenCalledTimes(1);
    });

    it("classifies a rename by both its old and new path (FAC-941)", async () => {
      const renamed = (from: string, to: string): PullRequestFileDiff =>
        ({ filename: to, previousFilename: from, status: "renamed", blobSha: "x", patch: null });
      for (const file of [renamed("shell/faces/x4/Face.tsx", "docs/Face.tsx"), renamed("docs/Face.tsx", "shell/faces/x4/Face.tsx")]) {
        // Ordinary CI and a code review only: the candidate, the smoke run and the visual verdict are needed.
        const { github, merge } = visualGitHub([], [file]);
        const h = harness({ github });
        const result = await evaluateAndMerge(h.deps, request());
        expect(result.outcome).toBe("refused");
        expect(result.requiredChecks).toEqual([...CODE, ...WINDOWS, "frontend", "candidate", "smoke"]);
        expect(codes(result)).toEqual(expect.arrayContaining(["required_check_skipped", "visual_review_missing"]));
        expect(details(result)).toMatch(/internal-windows\.yml run at aaaaaaaaaaaa/);
        expect(details(result)).toMatch(/ui-browser-smoke\.yml run at aaaaaaaaaaaa/);
        expect(h.visualQueries).toEqual([true]);
        expect(merge).not.toHaveBeenCalled();
      }
      // A rename between two paths the candidate builds but the smoke workflow does not watch.
      for (const file of [renamed("agent/src/a.ts", "docs/a.ts"), renamed("docs/main.rs", "shell/src-tauri/src/main.rs")]) {
        const { github, merge } = visualGitHub([], [file]);
        const h = harness({ github });
        const result = await evaluateAndMerge(h.deps, request());
        expect(result.outcome).toBe("refused");
        expect(result.requiredChecks).toEqual([...CODE, ...WINDOWS, "frontend", "candidate"]);
        expect(codes(result)).toEqual(["required_check_skipped", "required_check_skipped", "required_check_skipped"]);
        expect(h.visualQueries).toEqual([]);
        expect(merge).not.toHaveBeenCalled();
      }
      const { github, merge } = fakeGitHub({ headChecks: accountWebCi });
      github.pullRequestFiles = async () => [renamed("docs/guide.md", "account-web/guide.md")];
      const h = harness({ github });
      await expect(evaluateAndMerge(h.deps, request())).resolves.toMatchObject({ outcome: "merged", reasons: [], requiredChecks: CODE });
      expect(h.visualQueries).toEqual([]);
      expect(merge).toHaveBeenCalledTimes(1);
    });

    it("does not count a visual verdict written by the merging coordinator", async () => {
      const { github, merge } = visualGitHub(evidenceAt(HEAD));
      const result = await evaluateAndMerge(harness({ github, visualReviews: [visualReview({ reviewerAgentId: "coordinator" })] }).deps, request());
      expect(result).toMatchObject({ outcome: "refused", reasons: [{ code: "visual_review_missing" }] });
      expect(codes(result)).toEqual(["visual_review_missing"]);
      expect(merge).not.toHaveBeenCalled();
    });

    it("merges a visual change with code review, candidate, smoke run and a passing visual verdict all on the exact head", async () => {
      const { github, merge } = visualGitHub(evidenceAt(HEAD));
      const result = await evaluateAndMerge(harness({ github, visualReviews: [visualReview({ verdict: "fail" }), visualReview()] }).deps, request());
      expect(result).toMatchObject({ outcome: "merged", reasons: [], requiredChecks: [...CODE, ...WINDOWS, "frontend", "candidate", "smoke"] });
      expect(merge).toHaveBeenCalledWith(704, expect.objectContaining({ sha: HEAD }));
    });

    it("needs the candidate, the smoke run and a visual verdict for any UI path (FAC-1053)", async () => {
      for (const filename of ["shell/components/x.tsx", "shell/app/page.tsx", "shell/public/assets/a.png", "shell/package.json",
        "shell/scripts/lib/frame-compare.mjs"]) {
        const files = [changed("docs/a.md"), changed(filename)];
        const missing = visualGitHub(evidenceAt(HEAD), files);
        const noVerdict = harness({ github: missing.github });
        const refused = await evaluateAndMerge(noVerdict.deps, request());
        expect({ filename, outcome: refused.outcome, codes: codes(refused), requiredChecks: refused.requiredChecks }).toEqual({
          filename, outcome: "refused", codes: ["visual_review_missing"], requiredChecks: [...CODE, ...WINDOWS, "frontend", "candidate", "smoke"] });
        expect(noVerdict.visualQueries).toEqual([true]);
        expect(missing.merge).not.toHaveBeenCalled();
        const { github, merge } = visualGitHub(evidenceAt(HEAD), files);
        await expect(evaluateAndMerge(harness({ github, visualReviews: [visualReview()] }).deps, request()))
          .resolves.toMatchObject({ outcome: "merged", reasons: [] });
        expect(merge).toHaveBeenCalledTimes(1);
      }
    });

    it("needs the candidate but neither the smoke run nor a visual verdict for an agent or native-app change (FAC-1053)", async () => {
      for (const filenames of [["agent/src/x.ts"], ["shell/src-tauri/src/main.rs"], ["agent/src/x.ts", "shell/src-tauri/src/main.rs", "shell/tests/x.test.mjs"]]) {
        const files = filenames.map(changed);
        // The candidate alone: no smoke run exists and no visual review was written or looked for.
        const { github, merge } = visualGitHub(candidateAt(HEAD), files);
        const h = harness({ github });
        const result = await evaluateAndMerge(h.deps, request());
        expect({ filenames, outcome: result.outcome, reasons: result.reasons, requiredChecks: result.requiredChecks })
          .toEqual({ filenames, outcome: "merged", reasons: [], requiredChecks: [...CODE, ...WINDOWS, "frontend", "candidate"] });
        expect(h.visualQueries).toEqual([]);
        expect(merge).toHaveBeenCalledTimes(1);
        // The candidate is still needed.
        const bare = visualGitHub([], files);
        const refused = await evaluateAndMerge(harness({ github: bare.github }).deps, request());
        expect(refused.outcome).toBe("refused");
        expect(codes(refused)).toEqual(["required_check_skipped", "required_check_skipped", "required_check_skipped"]);
        expect(details(refused)).toMatch(/internal-windows\.yml run at aaaaaaaaaaaa/);
        expect(details(refused)).not.toMatch(/smoke|visual/i);
        expect(bare.merge).not.toHaveBeenCalled();
      }
    });

    it("fails closed on an unknown or empty changed-file list: every check, the smoke run and a visual verdict (FAC-1053)", async () => {
      const unreadable = async (): Promise<PullRequestFileDiff[]> => { throw new Error("GitHub 502"); };
      for (const [name, files] of [["empty", async (): Promise<PullRequestFileDiff[]> => []], ["unreadable", unreadable]] as const) {
        // `docs-only-scan` is the one path-scoped check an unknown list does not need: the code suites are needed instead.
        const everything = [...CODE, "catalog", ...WINDOWS, "frontend", "candidate", "smoke"];
        // Ordinary CI only.
        const bare = visualGitHub([]);
        bare.github.pullRequestFiles = files;
        const bareHarness = harness({ github: bare.github });
        const nothing = await evaluateAndMerge(bareHarness.deps, request());
        expect({ name, outcome: nothing.outcome, requiredChecks: nothing.requiredChecks }).toEqual({ name, outcome: "refused", requiredChecks: everything });
        expect(codes(nothing)).toEqual(expect.arrayContaining(["required_check_skipped", "visual_review_missing"]));
        expect(details(nothing)).toMatch(/internal-windows\.yml run at aaaaaaaaaaaa/);
        expect(details(nothing)).toMatch(/ui-browser-smoke\.yml run at aaaaaaaaaaaa/);
        expect(bareHarness.visualQueries).toEqual([true]);
        // The candidate without the smoke run, then both without a verdict.
        // (From here CI also carries Facette's `catalog` job, which an unknown list needs.)
        const noSmoke = visualGitHub([...candidateAt(HEAD), ok("catalog")]);
        noSmoke.github.pullRequestFiles = files;
        const withoutSmoke = await evaluateAndMerge(harness({ github: noSmoke.github, visualReviews: [visualReview()] }).deps, request());
        expect({ name, outcome: withoutSmoke.outcome, codes: codes(withoutSmoke) })
          .toEqual({ name, outcome: "refused", codes: ["required_check_skipped", "required_check_skipped", "visual_review_unbound"] });
        const noVerdict = visualGitHub([...evidenceAt(HEAD), ok("catalog")]);
        noVerdict.github.pullRequestFiles = files;
        const withoutVerdict = await evaluateAndMerge(harness({ github: noVerdict.github }).deps, request());
        expect({ name, outcome: withoutVerdict.outcome, codes: codes(withoutVerdict), requiredChecks: withoutVerdict.requiredChecks })
          .toEqual({ name, outcome: "refused", codes: ["visual_review_missing"], requiredChecks: everything });
        for (const fake of [bare, noSmoke, noVerdict]) expect(fake.merge).not.toHaveBeenCalled();
      }
    });

    it("keeps a clean base refresh code-reviewed but needs the candidate, the smoke run and the visual verdict on the refreshed head", async () => {
      // The code review covers REVIEWED; HEAD only merges base into it.
      const base = [review({ reviewedSha: REVIEWED })];
      for (const [visualReviews, evidence, outcome, expected] of [
        [[visualReview({ reviewedSha: REVIEWED })], evidenceAt(HEAD), "refused", ["visual_review_stale"]],
        // The smoke run of the reviewed head does not carry over either.
        [[visualReview()], [...candidateAt(HEAD), ...smokeAt(REVIEWED)], "refused", ["required_check_skipped", "visual_review_unbound"]],
        [[visualReview()], evidenceAt(HEAD), "merged", []],
      ] as const) {
        const { github, merge } = visualGitHub([...evidence]);
        github.compare = (inner => async (from: string, to: string) => {
          if (from === BASE && to === REVIEWED) {
            return { status: "diverged", aheadBy: 1, behindBy: 2, totalCommits: 1, complete: true, commits: [],
              files: [{ filename: "shell/faces/osrs/character/kaia/KaiaRive.tsx", status: "modified", blobSha: "x", patch: "@@ -1 +1 @@\n-a\n+b" }] };
          }
          return inner(from, to);
        })(github.compare);
        const result = await evaluateAndMerge(harness({ github, reviews: base, visualReviews: [...visualReviews] }).deps, request());
        expect(result.outcome).toBe(outcome);
        expect(codes(result)).toEqual(expected);
        expect(merge).toHaveBeenCalledTimes(outcome === "merged" ? 1 : 0);
      }
    });

    it("merges an ordinary ready Facette pull request whose CI skipped the jobs it never runs, draft leftovers included (FAC-1053)", async () => {
      const skipped = (name: string): MergeGateCheck => ({ kind: "check_run", name, status: "completed", conclusion: "skipped" });
      // The check runs observed on such a head: the ready run, then what its earlier draft run left behind.
      const readyRun = [
        ...["changes", "shell", "agent", "account-web", "pr-status-block", "gate / gate", "ready / summary", "worker",
          "windows-account-contract", "Vercel Preview Comments"].map(ok),
        ...["failure-loop", "failure-loop", "ready / gate", "ready / failure-loop", "gate / failure-loop", "gate / summary",
          "docs-only-scan", "catalog", "windows-fast", "windows-native"].map(skipped),
      ];
      const draftLeftovers = ["changes", "shell", "agent", "account-web", "ready", "docs-only-scan", "gate / gate", "gate / failure-loop",
        "windows-account-contract", "failure-loop"].map(skipped);
      const files = ["infra/account-service/scripts/seed-sandbox.mjs", "infra/account-service/test/ledger.test.mjs", "docs/ops/ACCOUNT_E2E_SANDBOX.md"].map(changed);
      for (const headChecks of [readyRun, [...readyRun, ...draftLeftovers]]) {
        const { github, merge } = fakeGitHub({ headChecks });
        github.pullRequestFiles = async () => files;
        const h = harness({ github });
        await expect(evaluateAndMerge(h.deps, request())).resolves.toMatchObject({ outcome: "merged", reasons: [], requiredChecks: CODE });
        expect(h.visualQueries).toEqual([]);
        expect(merge).toHaveBeenCalledTimes(1);
      }
      // The same head with `ready / summary` or `gate / gate` only skipped does not merge.
      for (const name of ["ready / summary", "gate / gate"]) {
        const { github, merge } = fakeGitHub({ headChecks: [...readyRun.filter(entry => entry.name !== name), skipped(name), ...draftLeftovers] });
        github.pullRequestFiles = async () => files;
        const result = await evaluateAndMerge(harness({ github }).deps, request());
        expect({ name, outcome: result.outcome, reasons: result.reasons }).toEqual({ name, outcome: "refused", reasons: [
          { code: "required_check_skipped", detail: `${name} runs on every change in this repository but did not pass on aaaaaaaaaaaa. It must run and pass.` }] });
        expect(merge).not.toHaveBeenCalled();
      }
    });

    it("merges a docs-only Facette pull request on its docs-only-scan, and refuses it when neither the scan nor the code suites ran (FAC-1053)", async () => {
      const skipped = (name: string): MergeGateCheck => ({ kind: "check_run", name, status: "completed", conclusion: "skipped" });
      const always = ["changes", "pr-status-block", "gate / gate", "ready / summary"].map(ok);
      const rest = ["catalog", "windows-fast", "windows-native", "failure-loop", "ready / gate", "ready / failure-loop", "gate / failure-loop", "gate / summary"].map(skipped);
      const cases: Array<[string, MergeGateCheck[], string, string[]]> = [
        ["scan passed, suites skipped", [...always, ok("docs-only-scan"), ...CODE.map(skipped), ...rest], "merged", []],
        // Facette ran the suites instead (a deleted SAFE file): accepted in place of the scan.
        ["suites passed, scan skipped", [...always, skipped("docs-only-scan"), ...CODE.map(ok), ...rest], "merged", []],
        ["neither ran", [...always, skipped("docs-only-scan"), ...CODE.map(skipped), ...rest], "refused", ["required_check_skipped"]],
      ];
      for (const [name, headChecks, outcome, expected] of cases) {
        const { github, merge } = fakeGitHub({ headChecks });
        github.pullRequestFiles = async () => [changed("docs/vision/x.md")];
        const result = await evaluateAndMerge(harness({ github }).deps, request());
        expect({ name, outcome: result.outcome, codes: codes(result), requiredChecks: result.requiredChecks })
          .toEqual({ name, outcome, codes: expected, requiredChecks: ["docs-only-scan"] });
        if (outcome === "refused") expect(details(result)).toMatch(/^docs-only-scan was skipped by a CI path filter/);
        expect(merge).toHaveBeenCalledTimes(outcome === "merged" ? 1 : 0);
      }
    });

    it("leaves a non-visual Facette change needing neither the candidate, the smoke run nor a visual verdict", async () => {
      const { github, merge } = fakeGitHub({ headChecks: accountWebCi });
      const h = harness({ github });
      await expect(evaluateAndMerge(h.deps, request())).resolves.toMatchObject({ outcome: "merged", reasons: [], requiredChecks: CODE });
      expect(h.visualQueries).toEqual([]);
      expect(merge).toHaveBeenCalledTimes(1);
    });
  });

  it("merges a current, green, reviewed head at that exact SHA", async () => {
    const { github, merge } = fakeGitHub({ headChecks: accountWebCi });
    const h = harness({ github });
    const result = await evaluateAndMerge(h.deps, request());
    expect(result).toMatchObject({ outcome: "merged", headSha: HEAD, reasons: [], redMainIssue: null });
    expect(merge).toHaveBeenCalledWith(704, expect.objectContaining({ sha: HEAD, method: "merge" }));
    expect(h.logs.map(entry => entry.action)).toEqual(["merge_gate.merged"]);
  });

  it("lets only the delegating coordinator merge", async () => {
    const { github, merge } = fakeGitHub({ headChecks: accountWebCi });
    const h = harness({ github });
    await expect(evaluateAndMerge(h.deps, request({ actor: { type: "agent", agentId: "claude-engineer", runId: "r" } })))
      .rejects.toThrow(/implementer cannot merge/);
    await expect(evaluateAndMerge(h.deps, request({ actor: { type: "agent", agentId: "someone-else", runId: "r" } })))
      .rejects.toThrow(/Only the coordinator/);
    await expect(evaluateAndMerge(h.deps, request({ actor: { type: "agent", agentId: "lead-coordinator", runId: "r" } })))
      .resolves.toMatchObject({ outcome: "merged" });
    expect(merge).toHaveBeenCalledTimes(1);
  });

  it("allows a recorded legacy coordinator handoff while rejecting its implementer and unrelated agents", async () => {
    const { github, merge } = fakeGitHub({ headChecks: accountWebCi });
    const h = harness({ github, legacyCoordinator: "coordinator", issues: [
      issue({ id: "task", assigneeAgentId: "coordinator", createdByAgentId: null, parentId: null }),
    ] });
    await expect(evaluateAndMerge(h.deps, request({ actor: { type: "agent", agentId: "claude-engineer", runId: "r" } })))
      .rejects.toThrow(/Only the coordinator/);
    await expect(evaluateAndMerge(h.deps, request({ actor: { type: "agent", agentId: "someone-else", runId: "r" } })))
      .rejects.toThrow(/Only the coordinator/);
    await expect(evaluateAndMerge(h.deps, request())).resolves.toMatchObject({ outcome: "merged" });
    expect(merge).toHaveBeenCalledTimes(1);
  });

  it("does not treat current assignment alone as a legacy handoff", async () => {
    const { github, merge } = fakeGitHub({ headChecks: accountWebCi });
    const h = harness({ github, issues: [issue({ id: "task", assigneeAgentId: "coordinator", createdByAgentId: null, parentId: null })] });
    await expect(evaluateAndMerge(h.deps, request())).rejects.toThrow(/implementer cannot merge/);
    expect(merge).not.toHaveBeenCalled();
  });

  it("counts a legacy coordinator's Codex runs as authorship before or after handoff", async () => {
    const { github, merge } = fakeGitHub({ headChecks: accountWebCi });
    const h = harness({ github, legacyCoordinator: "coordinator", coordinatorFamilies: ["openai"],
      reviews: [review({ reviewerModelFamilies: ["openai"] })], issues: [
        issue({ id: "task", assigneeAgentId: "coordinator", createdByAgentId: null, parentId: null }),
      ] });
    await expect(evaluateAndMerge(h.deps, request())).resolves.toMatchObject({
      outcome: "refused", reasons: [{ code: "review_not_independent" }],
    });
    expect(h.authorQueries).toEqual([{ issueId: "task", excludeAgentId: null }]);
    expect(merge).not.toHaveBeenCalled();
  });

  it("recognizes an accepted engineer-to-coordinator routing without allowing self merge or same-family review", async () => {
    const { github, merge } = fakeGitHub({ headChecks: accountWebCi });
    const h = harness({ github, routedCoordinator: "coordinator", coordinatorFamilies: ["openai"],
      reviews: [review({ reviewerModelFamilies: ["openai"] })], issues: [
        issue({ id: "task", assigneeAgentId: "claude-engineer", createdByAgentId: "claude-engineer", parentId: null }),
      ] });
    await expect(evaluateAndMerge(h.deps, request({ actor: { type: "agent", agentId: "claude-engineer", runId: "r" } })))
      .rejects.toThrow(/implementer cannot merge/);
    await expect(evaluateAndMerge(h.deps, request())).resolves.toMatchObject({
      outcome: "refused", reasons: [{ code: "review_not_independent" }],
    });
    expect(h.authorQueries).toEqual([{ issueId: "task", excludeAgentId: null }]);
    expect(merge).not.toHaveBeenCalled();
  });

  it("refuses a creator that implemented before handing the task to another agent", async () => {
    // Codex created and ran the task, then assigned it to Claude. The commit
    // trailer says only Paperclip, so it supplies no Codex family evidence.
    const { github, merge } = fakeGitHub({ headChecks: accountWebCi,
      commitMessage: "fix: change\n\nCo-Authored-By: Paperclip <noreply@paperclip.ai>" });
    const h = harness({ github, issues: [issue({ id: "task", createdByAgentId: "codex-engineer",
      assigneeAgentId: "claude-engineer" })], authorAgents: ["codex-engineer", "claude-engineer"],
      authorFamilies: ["anthropic"] });
    await expect(evaluateAndMerge(h.deps, request({ actor: { type: "agent", agentId: "codex-engineer", runId: "creator-run" } })))
      .rejects.toThrow(/implementer cannot merge/);
    expect(h.authorQueries).toEqual([{ issueId: "task", excludeAgentId: null }]);
    expect(merge).not.toHaveBeenCalled();
  });

  it("lets the routed coordinator merge after independent review and exact-head CI", async () => {
    const { github, merge } = fakeGitHub({ headChecks: accountWebCi });
    const h = harness({ github, routedCoordinator: "coordinator", issues: [
      issue({ id: "task", assigneeAgentId: "claude-engineer", createdByAgentId: "claude-engineer", parentId: null }),
    ] });
    await expect(evaluateAndMerge(h.deps, request({ actor: { type: "agent", agentId: "someone-else", runId: "r" } })))
      .rejects.toThrow(/Only the coordinator/);
    await expect(evaluateAndMerge(h.deps, request())).resolves.toMatchObject({ outcome: "merged" });
    expect(merge).toHaveBeenCalledTimes(1);
  });

  it("uses the completed reviewer's attested source authors for the live STA-315 board shape", async () => {
    const { github, merge } = fakeGitHub({ headChecks: accountWebCi });
    // The attesting reviewer has no run on the task; the Codex coordinator's
    // runs there are coordination, not source.
    const h = harness({ github, custodians: ["claude-engineer", "coordinator"],
      runFamilies: { "claude-engineer": ["anthropic"], coordinator: ["openai"] }, reviews: [review({
      reviewIssueIdentifier: "STA-326", sourceAuthorAgentIds: ["claude-engineer"],
    })], issues: [issue({ id: "task", status: "blocked", assigneeAgentId: "coordinator",
      createdByAgentId: "claude-engineer", parentId: null })] });
    await expect(evaluateAndMerge(h.deps, request({ actor: { type: "board" }, dryRun: true })))
      .resolves.toMatchObject({ outcome: "mergeable", reasons: [] });
    expect(h.custodianQueries).toEqual(["task"]);
    expect(h.authorQueries).toEqual([{ issueId: "task", excludeAgentId: null,
      sourceAuthorAgentIds: ["claude-engineer"], attesterAgentId: "codex-reviewer" }]);
    expect(merge).not.toHaveBeenCalled();
  });

  it("does not let a non-custodian that ran on the task attest itself out of the source authors", async () => {
    // A Codex helper ran on the task without ever creating, holding or
    // checking it out, so only its runs tie it to the source. It then reviews
    // the task and lists only Claude. No commit trailer names Codex.
    const { github, merge } = fakeGitHub({ headChecks: accountWebCi,
      commitMessage: "fix: change\n\nCo-Authored-By: Paperclip <noreply@paperclip.ai>" });
    const helperReview = review({ reviewIssueIdentifier: "STA-HELPER", reviewerAgentId: "codex-helper",
      sourceAuthorAgentIds: ["claude-engineer"] });
    const refusedSelfReview = { outcome: "refused", reasons: [{ code: "review_not_independent",
      detail: expect.stringContaining("worked on this task") }] };
    const h = harness({ github, reviews: [helperReview], custodians: ["claude-engineer", "coordinator"],
      runFamilies: { "claude-engineer": ["anthropic"], "codex-helper": ["openai"] } });
    await expect(evaluateAndMerge(h.deps, request({ actor: { type: "agent", agentId: "lead-coordinator", runId: "r" } })))
      .resolves.toMatchObject(refusedSelfReview);
    await expect(evaluateAndMerge(h.deps, request({ actor: { type: "board" }, dryRun: true })))
      .resolves.toMatchObject(refusedSelfReview);
    // The helper's own runs stayed counted, despite its narrower list.
    expect(h.authorQueries.filter(query => query.sourceAuthorAgentIds).map(query => query.attesterAgentId))
      .toEqual(["codex-helper", "codex-helper"]);
    // The same holds for a reviewer whose only runs on the task were comments:
    // no record shows those runs wrote no source.
    const commented = harness({ github, custodians: ["claude-engineer", "coordinator"],
      runFamilies: { "claude-engineer": ["anthropic"], coordinator: ["openai"], "codex-reviewer": ["openai"] },
      reviews: [review({ sourceAuthorAgentIds: ["claude-engineer"] })] });
    await expect(evaluateAndMerge(commented.deps, request({ actor: { type: "board" }, dryRun: true })))
      .resolves.toMatchObject(refusedSelfReview);
    expect(merge).not.toHaveBeenCalled();
  });

  it("does not let an implementer attest itself out of the source authors", async () => {
    // Codex held and implemented the task before it went to Claude. Codex then
    // reviews it and lists only Claude as the source author. No commit trailer
    // names Codex.
    const { github, merge } = fakeGitHub({ headChecks: accountWebCi,
      commitMessage: "fix: change\n\nCo-Authored-By: Paperclip <noreply@paperclip.ai>" });
    const selfAttested = review({ reviewIssueIdentifier: "STA-SELF", reviewerAgentId: "codex-implementer",
      sourceAuthorAgentIds: ["claude-engineer"] });
    const refusedSelfReview = { outcome: "refused", reasons: [{ code: "review_not_independent",
      detail: expect.stringContaining("worked on this task") }] };
    const h = harness({ github, reviews: [selfAttested], authorAgents: ["codex-implementer", "claude-engineer"],
      authorFamilies: ["anthropic", "openai"], custodians: ["claude-engineer", "codex-implementer", "coordinator"] });
    await expect(evaluateAndMerge(h.deps, request({ actor: { type: "agent", agentId: "lead-coordinator", runId: "r" } })))
      .resolves.toMatchObject(refusedSelfReview);
    await expect(evaluateAndMerge(h.deps, request({ actor: { type: "board" }, dryRun: true })))
      .resolves.toMatchObject(refusedSelfReview);
    // The attestation never narrowed authorship: every run on the task counted.
    expect(h.authorQueries.filter(query => query.sourceAuthorAgentIds)).toEqual([]);
    // Unreadable task history cannot establish the attester's independence either.
    const unknownHistory = harness({ github, reviews: [selfAttested], authorAgents: ["codex-implementer", "claude-engineer"],
      authorFamilies: ["anthropic", "openai"], custodians: null });
    await expect(evaluateAndMerge(unknownHistory.deps, request({ actor: { type: "board" }, dryRun: true })))
      .resolves.toMatchObject(refusedSelfReview);
    expect(unknownHistory.authorQueries).toEqual([{ issueId: "task", excludeAgentId: null }]);
    // A reviewer that lists itself as a source author is not attesting independence.
    const listsItself = harness({ github, reviews: [review({ sourceAuthorAgentIds: ["codex-reviewer"] })],
      authorAgents: ["codex-reviewer", "claude-engineer"], authorFamilies: ["anthropic", "openai"] });
    await expect(evaluateAndMerge(listsItself.deps, request({ actor: { type: "board" }, dryRun: true })))
      .resolves.toMatchObject(refusedSelfReview);
    expect(listsItself.custodianQueries).toEqual([]);
    expect(merge).not.toHaveBeenCalled();
  });

  it("lets a creator coordinator that ran on the task merge once an independent review attests the source authors (STA-287)", async () => {
    // The Codex coordinator created the task for Claude and later woke on it
    // to route review. A Codex reviewer that never held or ran on the task
    // attests Claude as the only source author at the merge head.
    const sta287 = (github: MergeGateGitHub, reviews: MergeReviewAttestation[], runFamilies?: Record<string, string[]>) => harness({
      github, reviews, runFamilies: runFamilies ?? { "claude-engineer": ["anthropic"], coordinator: ["openai"] },
      issues: [issue({ id: "task", createdByAgentId: "coordinator", assigneeAgentId: "claude-engineer", parentId: null })],
    });
    const attested = review({ reviewIssueIdentifier: "STA-300", sourceAuthorAgentIds: ["claude-engineer"] });
    const { github, merge } = fakeGitHub({ headChecks: accountWebCi });
    const h = sta287(github, [attested]);
    await expect(evaluateAndMerge(h.deps, request({ dryRun: true }))).resolves.toMatchObject({ outcome: "mergeable", reasons: [] });
    await expect(evaluateAndMerge(h.deps, request())).resolves.toMatchObject({ outcome: "merged" });
    expect(merge).toHaveBeenCalledTimes(1);
    // The coordinator's own runs were read, then left out only by the attested set.
    expect(h.authorQueries.slice(0, 2)).toEqual([{ issueId: "task", excludeAgentId: null },
      { issueId: "task", excludeAgentId: null, sourceAuthorAgentIds: ["claude-engineer"], attesterAgentId: "codex-reviewer" }]);

    // A commit trailer naming Codex is still Codex authorship, whatever the
    // attestation says, so the Codex attester is not cross-model.
    const codexCommit = fakeGitHub({ headChecks: accountWebCi,
      commitMessage: "fix: change\n\nCo-Authored-By: GPT-6 Codex <noreply@openai.com>" });
    await expect(evaluateAndMerge(sta287(codexCommit.github, [attested]).deps, request()))
      .rejects.toThrow(/STA-300 does not qualify: .*cross-model/);
    // An attesting reviewer that ran on the task is a potential author.
    const ranThere = fakeGitHub({ headChecks: accountWebCi });
    await expect(evaluateAndMerge(sta287(ranThere.github, [attested],
      { "claude-engineer": ["anthropic"], coordinator: ["openai"], "codex-reviewer": ["openai"] }).deps, request()))
      .rejects.toThrow(/STA-300 does not qualify: .*worked on this task/);
    expect(codexCommit.merge).not.toHaveBeenCalled();
    expect(ranThere.merge).not.toHaveBeenCalled();

    // A newer same-family attestation does not displace a qualifying one.
    const sameFamily = review({ reviewIssueId: "claude-review", reviewIssueIdentifier: "STA-CLAUDE", reviewerAgentId: "claude-attester",
      reviewerModelFamilies: ["anthropic"], sourceAuthorAgentIds: ["claude-engineer"] });
    const both = fakeGitHub({ headChecks: accountWebCi });
    await expect(evaluateAndMerge(sta287(both.github, [attested, sameFamily]).deps, request()))
      .resolves.toMatchObject({ outcome: "merged" });
    expect(both.merge).toHaveBeenCalledTimes(1);
  });

  it("does not let an ineligible attestation authorize a coordinator through another passing review (STA-364)", async () => {
    // Codex coordinator created the task and ran on it; commits name no Codex.
    const sta287 = (github: MergeGateGitHub, reviews: MergeReviewAttestation[], runFamilies?: Record<string, string[]>) => harness({
      github, reviews, runFamilies: runFamilies ?? { "claude-engineer": ["anthropic"], coordinator: ["openai"] },
      issues: [issue({ id: "task", createdByAgentId: "coordinator", assigneeAgentId: "claude-engineer", parentId: null })],
    });
    const paperclipCommit = { headChecks: accountWebCi, commitMessage: "fix: change\n\nCo-Authored-By: Paperclip <noreply@paperclip.ai>",
      baseChecks: [{ ...ok("verify"), conclusion: "failure" }] };
    // An independent Codex review with no attestation, and a newer Claude
    // review by a non-custodian with no task run that leaves the coordinator out.
    const unattested = review({ reviewIssueId: "codex-review", reviewIssueIdentifier: "STA-CODEX" });
    const sameFamily = review({ reviewIssueId: "claude-review", reviewIssueIdentifier: "STA-CLAUDE", reviewerAgentId: "claude-attester",
      reviewerModelFamilies: ["anthropic"], sourceAuthorAgentIds: ["claude-engineer"] });
    const cases: Array<[string, MergeReviewAttestation[], RegExp, Record<string, string[]>?]> = [
      ["same-family attestation plus unattested passing review", [unattested, sameFamily], /STA-CLAUDE does not qualify: .*cross-model/],
      // An independent review naming the coordinator stands against a newer exclusion.
      ["adverse independent attestation then same-family exclusion",
        [review({ ...unattested, sourceAuthorAgentIds: ["claude-engineer", "coordinator"] }), sameFamily], /attests this agent as a source author/],
      ["attester with no recorded model",
        [unattested, review({ ...sameFamily, reviewerAgentId: "unknown-attester", reviewerModelFamilies: [] })], /does not qualify: .*recorded no model/],
      ["attester that ran on the task", [unattested, review({ ...sameFamily, reviewerAgentId: "codex-attester", reviewerModelFamilies: ["openai"] })],
        /does not qualify: .*worked on this task/, { "claude-engineer": ["anthropic"], coordinator: ["openai"], "codex-attester": ["openai"] }],
      ["attester outside the merge bar", [unattested, review({ ...sameFamily, reviewerAgentId: "codex-attester", reviewerModelFamilies: ["openai"], p1: 1 })],
        /does not qualify: .*1 P1/],
    ];
    for (const [name, reviews, message, runFamilies] of cases) {
      const { github, merge } = fakeGitHub(paperclipCommit);
      const h = sta287(github, reviews, runFamilies);
      await expect(evaluateAndMerge(h.deps, request()), name).rejects.toThrow(message);
      expect(h.owners.size, name).toBe(0);
      expect(merge, name).not.toHaveBeenCalled();
    }
    // The board path does not narrow authorship with the ineligible list either.
    const board = fakeGitHub({ ...paperclipCommit, baseChecks: undefined });
    const h = sta287(board.github, [unattested, sameFamily]);
    await expect(evaluateAndMerge(h.deps, request({ actor: { type: "board" }, dryRun: true })))
      .resolves.toMatchObject({ outcome: "refused", reasons: [{ code: "review_not_independent", detail: expect.stringContaining("openai") },
        { code: "review_not_independent", detail: expect.stringContaining("anthropic") }] });
    expect(board.merge).not.toHaveBeenCalled();
  });

  it("refuses a coordinator that ran on the task without an attestation that leaves it out", async () => {
    const red = { ...ok("verify"), conclusion: "failure" };
    const cases: Array<[MergeReviewAttestation[], RegExp]> = [
      [[review()], /ran on the task/],
      // A review of an older head attests nothing about this one.
      [[review({ reviewedSha: REVIEWED, sourceAuthorAgentIds: ["claude-engineer"] })], /ran on the task/],
      // The task's assignee cannot attest the source authors.
      [[review({ reviewerAgentId: "claude-engineer", sourceAuthorAgentIds: ["claude-engineer-2"] })], /ran on the task/],
      // Its claim that the coordinator authored source still stands against it.
      [[review({ reviewerAgentId: "claude-engineer", sourceAuthorAgentIds: ["coordinator"] })], /attests this agent as a source author/],
      [[review({ sourceAuthorAgentIds: ["claude-engineer", "coordinator"] })], /attests this agent as a source author/],
    ];
    for (const [reviews, message] of cases) {
      const { github, merge } = fakeGitHub({ headChecks: accountWebCi, baseChecks: [red] });
      const h = harness({ github, reviews, runFamilies: { "claude-engineer": ["anthropic"], coordinator: ["openai"] },
        issues: [issue({ id: "task", createdByAgentId: "coordinator", assigneeAgentId: "claude-engineer", parentId: null })] });
      await expect(evaluateAndMerge(h.deps, request())).rejects.toThrow(message);
      // Refused before the gate could open a red-main issue for this actor.
      expect(h.owners.size).toBe(0);
      expect(merge).not.toHaveBeenCalled();
    }
  });

  it("refuses an ancestor coordinator that implemented before handing the task to another agent", async () => {
    const { github, merge } = fakeGitHub({ headChecks: accountWebCi,
      commitMessage: "fix: change\n\nCo-Authored-By: Paperclip <noreply@paperclip.ai>" });
    const h = harness({ github, issues: [
      issue({ id: "task", parentId: "parent", createdByAgentId: null, assigneeAgentId: "claude-engineer" }),
      issue({ id: "parent", assigneeAgentId: "codex-engineer" }),
    ], authorAgents: ["codex-engineer", "claude-engineer"], authorFamilies: ["anthropic"] });
    await expect(evaluateAndMerge(h.deps, request({ actor: { type: "agent", agentId: "codex-engineer", runId: "ancestor-run" } })))
      .rejects.toThrow(/implementer cannot merge/);
    expect(h.authorQueries).toEqual([{ issueId: "task", excludeAgentId: null }]);
    expect(merge).not.toHaveBeenCalled();
  });

  it("fails closed when a creator's run history cannot be established", async () => {
    const { github, merge } = fakeGitHub({ headChecks: accountWebCi });
    const h = harness({ github, authorFamilies: null });
    await expect(evaluateAndMerge(h.deps, request()))
      .rejects.toThrow(/authorship could not be established/);
    expect(merge).not.toHaveBeenCalled();
  });

  it("needs only CI after a clean update from main since the review", async () => {
    const { github } = fakeGitHub({ headChecks: accountWebCi });
    const h = harness({ github, reviews: [review({ reviewedSha: REVIEWED })] });
    await expect(evaluateAndMerge(h.deps, request())).resolves.toMatchObject({ outcome: "merged" });
  });

  it("refuses a head that is behind its base without merging", async () => {
    const { github, merge } = fakeGitHub({ headChecks: accountWebCi, behindBy: 1 });
    const h = harness({ github });
    const result = await evaluateAndMerge(h.deps, request());
    expect(result).toMatchObject({ outcome: "refused", reasons: [{ code: "base_update_required" }] });
    expect(merge).not.toHaveBeenCalled();
    expect(h.logs.map(entry => entry.action)).toEqual(["merge_gate.refused"]);
  });

  it("stops merges on red main with one owner and parks every dependent task on it", async () => {
    const red = [{ kind: "check_run" as const, name: "windows-fast", status: "completed", conclusion: "failure" }];
    const { github, merge } = fakeGitHub({ headChecks: accountWebCi, baseChecks: red });
    const h = harness({ github, issues: [
      issue({ id: "task-2", assigneeAgentId: "claude-engineer-2", createdByAgentId: "coordinator" }),
    ] });
    const first = await evaluateAndMerge(h.deps, request());
    const second = await evaluateAndMerge(h.deps, request({ issueId: "task-2", pullNumber: 705 }));
    expect(first).toMatchObject({ outcome: "parked", redMainIssue: { id: "red-main-1", created: true }, reasons: [{ code: "main_red" }] });
    expect(second).toMatchObject({ outcome: "parked", redMainIssue: { id: "red-main-1", created: false } });
    expect(h.owners.size).toBe(1);
    expect(h.issues.get("red-main-1")).toMatchObject({ priority: "critical", assigneeAgentId: "repair-engineer" });
    expect(h.parked).toEqual([{ issueId: "task", blockerIssueId: "red-main-1" }, { issueId: "task-2", blockerIssueId: "red-main-1" }]);
    expect(merge).not.toHaveBeenCalled();
  });

  it("lets the fix under the red-main issue merge while main is red", async () => {
    const red = [{ kind: "check_run" as const, name: "windows-fast", status: "completed", conclusion: "failure" }];
    const { github, merge } = fakeGitHub({ headChecks: [...facetteAlwaysCi, ok("windows-fast"), ok("windows-native")], baseChecks: red });
    const h = harness({ github });
    await reportRedMain(h.deps, { companyId: COMPANY, repo: "ethanmonlux/facette", baseRef: "main", evidence: "windows-fast fails on every PR", reportingIssueId: null, actor: coordinator });
    h.issues.set("fix", issue({ id: "fix", parentId: "red-main-1", assigneeAgentId: "claude-repair", createdByAgentId: "coordinator" }));
    const result = await evaluateAndMerge(h.deps, request({ issueId: "fix" }));
    expect(result).toMatchObject({ outcome: "merged", redMainIssue: { id: "red-main-1" } });
    expect(merge).toHaveBeenCalledTimes(1);
    expect(h.parked).toEqual([]);
  });

  it("keeps merges stopped while a reported red-main issue is open, even with no failing base check", async () => {
    const { github } = fakeGitHub({ headChecks: accountWebCi });
    const h = harness({ github, issues: [issue({ id: "reporter", assigneeAgentId: "claude-engineer-3" })] });
    const reported = await reportRedMain(h.deps, { companyId: COMPANY, repo: "ethanmonlux/facette", baseRef: "main",
      evidence: "windows-fast fails on 3 PRs with the same content-pack test", reportingIssueId: "reporter", actor: coordinator });
    expect(reported).toMatchObject({ created: true, issue: { id: "red-main-1" } });
    expect(h.parked).toEqual([{ issueId: "reporter", blockerIssueId: "red-main-1" }]);
    await expect(evaluateAndMerge(h.deps, request())).resolves.toMatchObject({ outcome: "parked", reasons: [{ code: "main_red" }] });
  });

  it("evaluates without merging, parking or logging on a dry run", async () => {
    const red = [{ kind: "check_run" as const, name: "windows-fast", status: "completed", conclusion: "failure" }];
    const { github, merge } = fakeGitHub({ headChecks: accountWebCi, baseChecks: red });
    const h = harness({ github });
    await expect(evaluateAndMerge(h.deps, request({ dryRun: true }))).resolves.toMatchObject({ outcome: "refused" });
    expect(merge).not.toHaveBeenCalled();
    expect(h.parked).toEqual([]);
    expect(h.logs).toEqual([]);
    const green = harness({ github: fakeGitHub({ headChecks: accountWebCi }).github });
    await expect(evaluateAndMerge(green.deps, request({ dryRun: true }))).resolves.toMatchObject({ outcome: "mergeable" });
  });

  it("serializes merges into one base: of two concurrent green PRs only one merges", async () => {
    const base = fakeBase();
    const first = fakeGitHub({ headChecks: accountWebCi, base });
    const second = fakeGitHub({ headChecks: accountWebCi, base, headSha: "f".repeat(40) });
    const locks = new Set<string>();
    const h1 = harness({ github: first.github, locks });
    const h2 = harness({ github: second.github, locks, reviews: [review({ reviewedSha: "f".repeat(40), pullRequest: "ethanmonlux/facette#705" })] });
    const [one, two] = await Promise.all([evaluateAndMerge(h1.deps, request()), evaluateAndMerge(h2.deps, request({ pullNumber: 705 }))]);
    expect(one).toMatchObject({ outcome: "merged" });
    expect(two).toMatchObject({ outcome: "refused", reasons: [{ code: "merge_in_progress" }] });
    expect(first.merge).toHaveBeenCalledTimes(1);
    expect(second.merge).not.toHaveBeenCalled();
    // Retried after the first landed, the second head is behind the new base.
    await expect(evaluateAndMerge(h2.deps, request({ pullNumber: 705 })))
      .resolves.toMatchObject({ outcome: "refused", reasons: [{ code: "base_update_required", detail: expect.stringContaining("1 commit(s) behind") }] });
    expect(second.merge).not.toHaveBeenCalled();
  });

  it("refuses when the base moves outside the gate while it is checking", async () => {
    const { github, merge, base } = fakeGitHub({ headChecks: accountWebCi });
    const h = harness({ github, onLoadReviews: () => { base.head = NEW_BASE; } });
    await expect(evaluateAndMerge(h.deps, request()))
      .resolves.toMatchObject({ outcome: "refused", reasons: [{ code: "base_update_required", detail: expect.stringContaining("moved") }] });
    expect(merge).not.toHaveBeenCalled();
  });

  it("reads authorship from run provenance and commit trailers, and fails closed without it", async () => {
    const { github } = fakeGitHub({ headChecks: accountWebCi });
    // The implementer is now configured as Codex, but its runs and commits recorded Claude.
    const sameFamily = harness({ github, authorFamilies: ["anthropic"], reviews: [review({ reviewerModelFamilies: ["anthropic"] })] });
    await expect(evaluateAndMerge(sameFamily.deps, request()))
      .resolves.toMatchObject({ outcome: "refused", reasons: [{ code: "review_not_independent" }] });
    // Only the merging coordinator's runs are left out; reviewers' runs count.
    expect(sameFamily.authorQueries).toEqual([
      { issueId: "task", excludeAgentId: null },
      { issueId: "task", excludeAgentId: "coordinator" },
    ]);
    // A run with no recorded model leaves only the trailers, which still name Claude.
    const trailersOnly = harness({ github, authorFamilies: [], reviews: [review({ reviewerModelFamilies: ["anthropic"] })] });
    await expect(evaluateAndMerge(trailersOnly.deps, request()))
      .resolves.toMatchObject({ outcome: "refused", reasons: [{ code: "review_not_independent", detail: expect.stringContaining("anthropic") }] });
    const missing = harness({ github, authorFamilies: null, issues: [
      issue({ id: "task", parentId: "parent", assigneeAgentId: "claude-engineer", createdByAgentId: null }),
      issue({ id: "parent", assigneeAgentId: "coordinator" }),
    ] });
    await expect(evaluateAndMerge(missing.deps, request()))
      .rejects.toThrow(/authorship could not be established/);
    expect(coAuthorModelFamilies(["fix\n\nCo-authored-by: Codex <codex@openai.com>", null])).toEqual(["openai"]);
  });

  it("refuses a previous implementer as reviewer after the task is handed to another model (STA-218)", async () => {
    const { github, merge } = fakeGitHub({ headChecks: accountWebCi });
    // codex-reviewer authored part of the PR with Codex, then the task moved to
    // claude-engineer. No co-author trailers name Codex.
    const handedOff = harness({ github, authorAgents: ["claude-engineer", "codex-reviewer"], authorFamilies: ["anthropic", "openai"] });
    await expect(evaluateAndMerge(handedOff.deps, request()))
      .resolves.toMatchObject({ outcome: "refused", reasons: [{ code: "review_not_independent", detail: expect.stringContaining("worked on this task") }] });
    // Another Codex agent reviewing the mixed-authorship change shares a family.
    const mixed = harness({ github, authorAgents: ["claude-engineer", "codex-implementer"], authorFamilies: ["anthropic", "openai"] });
    await expect(evaluateAndMerge(mixed.deps, request()))
      .resolves.toMatchObject({ outcome: "refused", reasons: [{ code: "review_not_independent", detail: expect.stringContaining("openai") }] });
    expect(merge).not.toHaveBeenCalled();
  });

  it("does not count a review written by the merging coordinator", async () => {
    const { github } = fakeGitHub({ headChecks: accountWebCi });
    const h = harness({ github, reviews: [review({ reviewerAgentId: "coordinator" })] });
    await expect(evaluateAndMerge(h.deps, request())).resolves.toMatchObject({ outcome: "refused", reasons: [{ code: "review_missing" }] });
  });
});

